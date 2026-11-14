process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'production'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { server, db } = require('./server')
const { encodePassword } = require('./auth')
let base
const initial = 'School-Initial-2026'
async function call(path, method = 'GET', body, token) {
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}
before(async () => {
  db.prepare('INSERT INTO users(id,name,department,role) VALUES(?,?,?,?)').run('00001', '老师', '学院', 'counselor')
  db.prepare('INSERT INTO credentials VALUES(?,?,1)').run('00001', await encodePassword(initial))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
})

test('正式登录仅允许名单与密码匹配，强制首次修改并撤销旧会话', async () => {
  assert.equal((await call('/api/auth/dev', 'POST', { id: 'other', name: '冒用' })).status, 404)
  assert.equal((await call('/api/auth/login', 'POST', { id: 'unknown', password: initial })).status, 401)
  assert.equal((await call('/api/auth/login', 'POST', { id: '00001', password: 'wrong-password' })).status, 401)
  const login = await call('/api/auth/login', 'POST', { id: '00001', password: initial })
  assert.equal(login.status, 200)
  assert.equal(login.body.mustChangePassword, true)
  assert.equal(login.body.user.id, '00001')
  assert.ok(!JSON.stringify(login.body).includes('password_hash'))
  const first = login.body.token
  const second = (await call('/api/auth/login', 'POST', { id: '00001', password: initial })).body.token
  const blocked = await call('/api/activities', 'GET', null, first)
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED')
  assert.equal((await call('/api/auth/password', 'POST', { oldPassword: initial, newPassword: initial }, first)).status, 400)
  const newPassword = 'My-Personal-Password-2026'
  const changed = await call('/api/auth/password', 'POST', { oldPassword: initial, newPassword }, first)
  assert.equal(changed.status, 200)
  assert.equal(changed.body.mustChangePassword, false)
  assert.equal((await call('/api/me', 'GET', null, first)).status, 401)
  assert.equal((await call('/api/me', 'GET', null, second)).status, 401)
  assert.equal((await call('/api/activities', 'GET', null, changed.body.token)).status, 200)
  assert.equal((await call('/api/auth/login', 'POST', { id: '00001', password: initial })).status, 401)
  assert.equal((await call('/api/auth/login', 'POST', { id: '00001', password: newPassword })).status, 200)
  const encoded = db.prepare('SELECT password_hash FROM credentials WHERE user_id=?').get('00001').password_hash
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/)
  assert.ok(!encoded.includes(newPassword))
  db.prepare('UPDATE users SET enabled=0 WHERE id=?').run('00001')
  assert.equal((await call('/api/auth/login', 'POST', { id: '00001', password: newPassword })).status, 401)
  assert.equal((await call('/api/me', 'GET', null, changed.body.token)).status, 401)
})

test('账号限流不依赖客户端提供的 IP，未知工号不会创建账号', async () => {
  db.exec('DELETE FROM auth_limits')
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('/api/auth/login', 'POST', { id: 'unlisted', password: initial })).status, 401)
  }
  assert.equal((await call('/api/auth/login', 'POST', { id: 'unlisted', password: initial })).status, 429)
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get('unlisted'), undefined)
})
