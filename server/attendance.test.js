process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { server, db } = require('./server')
let base, admin
const tokens = {}
async function call(path, method = 'GET', body, token = admin) {
  const response = await fetch(base + path, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}
async function event() {
  const created = await call('/api/admin/activities', 'POST', {
    title: '现场测试', startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 7200000).toISOString(), creditHours: 1.5,
  })
  const id = created.body.id
  for (const token of Object.values(tokens)) assert.equal((await call('/api/activities/' + id + '/register', 'POST', {}, token)).status, 200)
  return id
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  admin = (await call('/api/auth/dev', 'POST', { id: 'admin', name: '管理员', department: '学院' }, null)).body.token
  for (const id of ['u1', 'u2', 'u3']) tokens[id] = (await call('/api/auth/dev', 'POST', { id, name: id, department: '学院' }, null)).body.token
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
})

test('二维码签到与签退验证报名、权限、重复和顺序，记录不会自行计入学时', async () => {
  const id = await event(), root = '/api/admin/activities/' + id + '/attendance', own = '/api/activities/' + id + '/attendance'
  assert.equal((await call(root + '/in', 'POST', { method: 'qr' }, tokens.u1)).status, 403)
  assert.equal((await call(root + '/out', 'POST', { method: 'qr' })).status, 409)
  const opened = await call(root + '/in', 'POST', { method: 'qr' })
  assert.equal(opened.status, 200)
  assert.equal(Buffer.from(opened.body.qrPng, 'base64').subarray(1, 4).toString(), 'PNG')
  assert.match(opened.body.qrText, new RegExp('^CTP1:' + id + ':in:[a-f0-9]{64}$'))
  const state = await call(own, 'GET', null, tokens.u1)
  assert.ok(!JSON.stringify(state).includes('qr_hash'))
  assert.ok(!JSON.stringify(state).includes(opened.body.qrText))
  assert.equal((await call(own + '/in', 'POST', { qrText: 'wrong' }, tokens.u1)).status, 403)
  assert.equal((await call(own + '/in', 'POST', { qrText: opened.body.qrText }, tokens.u1)).status, 200)
  assert.equal((await call(own + '/in', 'POST', { qrText: opened.body.qrText }, tokens.u1)).status, 409)
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 1000, id)
  const out = await call(root + '/out', 'POST', { method: 'qr' })
  assert.equal(out.status, 200)
  assert.equal((await call(own + '/out', 'POST', { qrText: out.body.qrText }, tokens.u2)).status, 409)
  assert.equal((await call(own + '/out', 'POST', { qrText: opened.body.qrText }, tokens.u1)).status, 403)
  assert.equal((await call(own + '/out', 'POST', { qrText: out.body.qrText }, tokens.u1)).status, 200)
  const registration = db.prepare('SELECT confirmed_at,credited_hours FROM registrations WHERE activity_id=? AND user_id=?').get(id, 'u1')
  assert.equal(registration.confirmed_at, null)
  assert.equal(registration.credited_hours, 0)
  const ownState = await call(own, 'GET', null, tokens.u1)
  const otherState = await call(own, 'GET', null, tokens.u2)
  assert.equal(ownState.body.records.length, 2)
  assert.equal(otherState.body.records.length, 0)
  assert.equal((await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: 'u1' })).status, 200)
})

test('刷新、关闭、过期和取消使二维码失效，其他活动不能复用', async () => {
  const id = await event(), other = await event(), root = '/api/admin/activities/' + id + '/attendance'
  const first = await call(root + '/in', 'POST', { method: 'qr' })
  const second = await call(root + '/in', 'POST', { method: 'qr' })
  const path = '/api/activities/' + id + '/attendance/in'
  assert.equal((await call(path, 'POST', { qrText: first.body.qrText }, tokens.u1)).status, 403)
  await call('/api/admin/activities/' + other + '/attendance/in', 'POST', { method: 'qr' })
  assert.equal((await call('/api/activities/' + other + '/attendance/in', 'POST', { qrText: second.body.qrText }, tokens.u1)).status, 403)
  assert.equal((await call(root + '/in', 'DELETE')).status, 200)
  assert.equal((await call(path, 'POST', { qrText: second.body.qrText }, tokens.u1)).status, 409)
  const third = await call(root + '/in', 'POST', { method: 'qr' })
  db.prepare('UPDATE attendance_sessions SET closes_at=? WHERE activity_id=?').run(Date.now() - 1, id)
  assert.equal((await call(path, 'POST', { qrText: third.body.qrText }, tokens.u1)).status, 409)
  const fourth = await call(root + '/in', 'POST', { method: 'qr' })
  db.prepare("UPDATE activities SET status='cancelled' WHERE id=?").run(id)
  assert.equal((await call(path, 'POST', { qrText: fourth.body.qrText }, tokens.u1)).status, 409)
})

test('定位和双重验证检查范围、坐标、精度及二维码', async () => {
  const id = await event(), root = '/api/admin/activities/' + id + '/attendance'
  const geo = { latitude: 36.65, longitude: 117.0, radius: 100, method: 'both' }
  assert.equal((await call(root + '/in', 'POST', { ...geo, latitude: false })).status, 400)
  const opened = await call(root + '/in', 'POST', geo)
  const path = '/api/activities/' + id + '/attendance/in'
  const input = { qrText: opened.body.qrText, latitude: geo.latitude, longitude: geo.longitude, accuracy: 10 }
  assert.equal((await call(path, 'POST', { ...input, qrText: 'wrong' }, tokens.u1)).status, 403)
  assert.equal((await call(path, 'POST', { ...input, latitude: 36.7 }, tokens.u1)).status, 403)
  assert.equal((await call(path, 'POST', { ...input, accuracy: 200 }, tokens.u1)).status, 400)
  assert.equal((await call(path, 'POST', { ...input, latitude: null }, tokens.u1)).status, 400)
  assert.equal((await call(path, 'POST', input, tokens.u1)).status, 200)
  const record = db.prepare('SELECT distance,accuracy,method FROM attendance_records WHERE activity_id=?').get(id)
  assert.equal(record.distance, 0)
  assert.equal(record.accuracy, 10)
  assert.equal(record.method, 'both')
  const location = await call(root + '/in', 'POST', { ...geo, method: 'location' })
  assert.equal(location.body.qrPng, null)
  assert.equal((await call(path, 'POST', { latitude: geo.latitude, longitude: geo.longitude, accuracy: 10 }, tokens.u2)).status, 200)
  db.prepare('DELETE FROM registrations WHERE activity_id=? AND user_id=?').run(id, 'u3')
  assert.equal((await call(path, 'POST', input, tokens.u3)).status, 403)
  assert.equal((await call('/api/admin/activities/' + id + '/attendance', 'GET', null, tokens.u1)).status, 403)
})
