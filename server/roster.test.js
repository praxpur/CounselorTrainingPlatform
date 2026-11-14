process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'production'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { server, db } = require('./server')
const { importRoster } = require('./roster')
const { parseRosterCsv } = require('../utils/roster')
let base, admin, secondAdmin, counselor
const password = 'School-Initial-2026'
const row = (id, role = 'counselor') => ({ id, name: '教师' + id, department: '学院', role, initialPassword: password })
async function call(path, method = 'GET', body, token = admin) {
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}
before(async () => {
  await importRoster(db, [row('a1', 'admin'), row('a2', 'admin'), row('u1')], { allowAdmins: true })
  db.exec('UPDATE credentials SET must_change=0')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  for (const id of ['a1', 'a2', 'u1']) {
    const token = (await call('/api/auth/login', 'POST', { id, password }, null)).body.token
    if (id === 'a1') admin = token
    else if (id === 'a2') secondAdmin = token
    else counselor = token
  }
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
})

test('CSV 正确解析引号、中文、逗号和前导零，拒绝坏表头和错列', () => {
  const rows = parseRosterCsv('\uFEFF工号,姓名,学院/部门,初始密码\r\n00003,"王,老师","学院""一部",School-Initial-2026\r\n')
  assert.equal(rows[0].id, '00003')
  assert.equal(rows[0].name, '王,老师')
  assert.equal(rows[0].department, '学院"一部')
  assert.throws(() => parseRosterCsv('工号,姓名\n1,王'), /表头/)
  assert.throws(() => parseRosterCsv('工号,姓名,学院/部门,初始密码\n1,"未闭合'), /未闭合/)
})

test('多管理员可导入辅导员，整批冲突回滚且不能通过接口提权', async () => {
  assert.equal((await call('/api/admin/users/import', 'POST', { rows: [row('00003')] })).status, 201)
  const login = await call('/api/auth/login', 'POST', { id: '00003', password }, null)
  assert.equal(login.status, 200)
  assert.equal(login.body.mustChangePassword, true)
  assert.equal((await call('/api/admin/users/import', 'POST', { rows: [row('second')] }, secondAdmin)).status, 201)
  assert.equal((await call('/api/admin/users/import', 'POST', { rows: [row('forbidden')] }, counselor)).status, 403)
  assert.equal((await call('/api/admin/users/import', 'POST', { rows: [row('elevated', 'admin')] })).status, 400)
  assert.equal((await call('/api/admin/users/import', 'POST', { rows: [row('atomic'), row('00003')] })).status, 409)
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get('atomic'), undefined)
  assert.equal((await call('/api/admin/users/import', 'POST', { rows: [row('dup'), row('dup')] })).status, 400)
  assert.equal((await call('/api/admin/users', 'POST', { id: 'no-pass', name: '教师', department: '学院' })).status, 400)
  assert.equal((await call('/api/admin/users', 'POST', row('single'))).status, 201)
  const list = await call('/api/admin/users')
  assert.ok(!JSON.stringify(list).includes('password'))
})

test('重置密码撤销会话，辅导员不能重置他人，管理员不能重置其他管理员', async () => {
  const next = 'New-School-Initial-2026'
  assert.equal((await call('/api/admin/users/u1/password', 'POST', { initialPassword: next }, counselor)).status, 403)
  assert.equal((await call('/api/admin/users/a2/password', 'POST', { initialPassword: next })).status, 404)
  assert.equal((await call('/api/admin/users/u1/password', 'POST', { initialPassword: next })).status, 200)
  assert.equal((await call('/api/me', 'GET', null, counselor)).status, 401)
  assert.equal((await call('/api/auth/login', 'POST', { id: 'u1', password }, null)).status, 401)
  const login = await call('/api/auth/login', 'POST', { id: 'u1', password: next }, null)
  assert.equal(login.status, 200)
  assert.equal(login.body.mustChangePassword, true)
})

test('旧名单可以补设初始密码而不覆盖身份，异步哈希后复核权限', async () => {
  db.prepare("INSERT INTO users(id,name,department,role) VALUES('legacy','教师legacy','学院','counselor')").run()
  assert.equal((await importRoster(db, [row('legacy')])).imported, 1)
  assert.equal((await call('/api/auth/login', 'POST', { id: 'legacy', password }, null)).status, 200)
  await assert.rejects(importRoster(db, [row('revoked')], { authorize() {
    throw Object.assign(new Error('权限已撤销'), { status: 403 })
  } }), { status: 403 })
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get('revoked'), undefined)
})

test('离线工具可初始化、拒绝重复初始化、增加管理员并重置密码', async () => {
  const fs = require('node:fs/promises'), path = require('node:path')
  const { promisify } = require('node:util')
  const execFile = promisify(require('node:child_process').execFile)
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'training-roster-'))
  const dbPath = path.join(root, 'test.db'), file = path.join(root, 'roster.json')
  const options = { env: { ...process.env, DB_PATH: dbPath }, cwd: __dirname }
  try {
    await fs.writeFile(file, JSON.stringify([row('ops1', 'admin')]))
    const result = await execFile(process.execPath, ['manage-users.js', 'bootstrap', file], options)
    assert.match(result.stdout, /已导入 1/)
    assert.ok(!result.stdout.includes(password))
    await assert.rejects(execFile(process.execPath, ['manage-users.js', 'bootstrap', file], options))
    await fs.writeFile(file, JSON.stringify([row('ops2', 'admin')]))
    await execFile(process.execPath, ['manage-users.js', 'import', file], options)
    await fs.writeFile(file, JSON.stringify({ id: 'ops1', initialPassword: 'Reset-Initial-2026' }))
    await execFile(process.execPath, ['manage-users.js', 'reset', file], options)
    const copy = new (require('node:sqlite').DatabaseSync)(dbPath)
    assert.equal(copy.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n, 2)
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM credentials WHERE must_change=1').get().n, 2)
    copy.close()
  } finally {
    // root 是本测试直接创建的独立临时目录。
    await fs.rm(root, { recursive: true, force: true })
  }
})
