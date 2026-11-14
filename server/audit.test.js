process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { server, db } = require('./server')
let base, admin, secondAdmin, user
const secret = 'Initial-Audit-Password-2026'
async function call(route, method = 'GET', body, token = admin) {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
async function login(id) { return (await call('/api/auth/dev', 'POST', { id, name: id, department: '学院' }, null)).body.token }
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  admin = await login('admin')
  db.prepare("INSERT INTO users(id,name,department,role) VALUES('admin2','admin2','学院','admin')").run()
  secondAdmin = await login('admin2')
  user = await login('user')
  await call('/api/admin/users', 'POST', { id: 'uA', name: '甲', department: '学院', initialPassword: secret })
  await call('/api/admin/users', 'POST', { id: 'uB', name: '乙', department: '学院' })
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
})

test('审计使用请求上下文，并行管理员操作保持正确身份和变更前后值', async () => {
  let request, observe
  const accepted = new Promise(resolve => { observe = req => { if (req.url === '/api/admin/users/uA') resolve() }; server.on('request', observe) })
  const bytes = Buffer.from(JSON.stringify({ name: '甲更新', department: '新学院' }))
  const pending = new Promise((resolve, reject) => {
    request = http.request(base + '/api/admin/users/uA', { method: 'PUT', headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject); request.write(bytes.subarray(0,5))
  })
  await accepted
  server.off('request', observe)
  assert.equal((await call('/api/admin/users/uB', 'PUT', { name: '乙更新', department: '第二学院' }, secondAdmin)).status, 200)
  request.end(bytes.subarray(5))
  assert.equal(await pending, 200)
  const a = db.prepare("SELECT * FROM audit_logs WHERE action='users.update' AND target='uA' ORDER BY id DESC LIMIT 1").get()
  const b = db.prepare("SELECT * FROM audit_logs WHERE action='users.update' AND target='uB' ORDER BY id DESC LIMIT 1").get()
  assert.equal(a.actor_id, 'admin')
  assert.equal(b.actor_id, 'admin2')
  assert.notEqual(a.request_id, b.request_id)
  assert.equal(JSON.parse(a.detail).before.name, '甲')
  assert.equal(JSON.parse(a.detail).after.name, '甲更新')
})

test('业务变更与审计同事务，审计落库失败时变更不会偷偷成功', async () => {
  db.exec("CREATE TRIGGER simulate_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='users.update' AND NEW.target='uA' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  const logError = console.error
  try {
    console.error = () => {}
    assert.equal((await call('/api/admin/users/uA', 'PUT', { name: '不应保存', department: '学院' })).status, 500)
  } finally {
    console.error = logError
    db.exec('DROP TRIGGER simulate_audit_failure')
  }
  assert.equal(db.prepare("SELECT name FROM users WHERE id='uA'").get().name, '甲更新')
  const failure = db.prepare("SELECT * FROM audit_logs WHERE action='request.write' AND target='/api/admin/users/uA' ORDER BY id DESC LIMIT 1").get()
  assert.equal(failure.outcome, 'failure')
})

test('登录失败、导出和读取权限有记录，密码、凭据哈希与 Token 不落审计', async () => {
  assert.equal((await call('/api/auth/login', 'POST', { id: 'uA', password: 'Wrong-Password-2026' }, null)).status, 401)
  const failed = db.prepare("SELECT * FROM audit_logs WHERE action='auth.login' AND target='uA' ORDER BY id DESC LIMIT 1").get()
  assert.equal(failed.outcome, 'failure')
  assert.equal(failed.actor_id, 'anonymous')
  const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
  const response = await fetch(base + '/api/admin/exports/ranking?year=' + year, { headers: { authorization: 'Bearer ' + admin } })
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  const exported = db.prepare("SELECT * FROM audit_logs WHERE action='data.export' ORDER BY id DESC LIMIT 1").get()
  assert.equal(exported.actor_id, 'admin')
  assert.equal(exported.request_id, response.headers.get('x-request-id'))
  assert.equal((await call('/api/admin/audit-logs', 'GET', null, user)).status, 403)
  assert.equal((await call('/api/admin/audit-logs', 'GET', null, null)).status, 401)
  const serialized = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all())
  for (const value of [secret, 'Wrong-Password-2026', 'password_hash', 'token_hash', admin, secondAdmin, user]) assert.ok(!serialized.includes(value), value)
})

test('审计支持稳定游标与参数化筛选，普通接口不能改删历史', async () => {
  const first = await call('/api/admin/audit-logs?limit=1&action=users.update')
  assert.equal(first.status, 200)
  assert.equal(first.body.rows.length, 1)
  assert.equal(first.body.hasMore, true)
  const next = await call('/api/admin/audit-logs?limit=1&action=users.update&before=' + first.body.nextCursor)
  assert.equal(next.body.rows.length, 1)
  assert.ok(next.body.rows[0].id < first.body.rows[0].id)
  assert.equal((await call('/api/admin/audit-logs?limit=101')).status, 400)
  const injected = await call('/api/admin/audit-logs?actor=' + encodeURIComponent("' OR 1=1 --"))
  assert.equal(injected.status, 200)
  assert.equal(injected.body.rows.length, 0)
  assert.equal((await call('/api/admin/audit-logs', 'DELETE')).status, 404)
})
