const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'training-withdrawal-'))
process.env.DB_PATH = ':memory:'
process.env.UPLOAD_DIR = uploadRoot
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { ensureRegistrationSchema, createRegistration } = require('./registration')
const { server, db } = require('./server')
let base, admin
const users = {}
async function call(route, method = 'GET', body, token = users.a) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}
async function activity(capacity = 1, title = '取消报名测试') {
  const result = await call('/api/admin/activities', 'POST', {
    title, capacity, creditHours: 1.5,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 7200000).toISOString(),
  }, admin)
  assert.equal(result.status, 201)
  return result.body.id
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  for (const id of ['admin', 'a', 'b', 'c', ...Array.from({ length: 20 }, (_, i) => 'race' + i)]) {
    const login = await call('/api/auth/dev', 'POST', { id, name: id, department: '学院' }, null)
    assert.equal(login.status, 200)
    if (id === 'admin') admin = login.body.token
    else users[id] = login.body.token
  }
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
  fs.rmSync(uploadRoot, { recursive: true, force: true })
})

test('取消释放名额但保留记录，重新报名复用原行并记录前后状态', async () => {
  const id = await activity()
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {})).status, 200)
  const result = await call('/api/activities/' + id + '/register', 'DELETE')
  assert.equal(result.status, 200)
  assert.equal(result.body.registered, false)
  assert.equal(result.body.registeredCount, 0)
  assert.ok(result.body.withdrawnAt)
  const row = db.prepare('SELECT * FROM registrations WHERE activity_id=? AND user_id=?').get(id, 'a')
  assert.ok(row.cancelled_at)
  assert.equal(row.credited_hours, 0)
  assert.equal((await call('/api/admin/activities/' + id + '/attendees', 'GET', null, admin)).body.length, 0)
  const cancelled = await call('/api/my/records?filter=cancelled&limit=20')
  assert.equal(cancelled.body.rows.find(record => record.id === id).reviewStatus, 'withdrawn')
  assert.equal(cancelled.body.rows.find(record => record.id === id).recognizedHours, 0)
  assert.equal((await call('/api/activities/' + id + '/register', 'DELETE')).status, 409)
  const resumed = await call('/api/activities/' + id + '/register', 'POST', {})
  assert.equal(resumed.status, 200)
  assert.equal(resumed.body.registered, true)
  assert.equal(resumed.body.withdrawnAt, null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations WHERE activity_id=? AND user_id=?').get(id, 'a').n, 1)

})

test('取消只操作当前会话，名额释放后被他人占用不能强行重新报名', async () => {
  const id = await activity(2)
  await call('/api/activities/' + id + '/register', 'POST', {}, users.a)
  await call('/api/activities/' + id + '/register', 'POST', {}, users.b)
  assert.equal((await call('/api/activities/' + id + '/register?userId=b', 'DELETE', { userId: 'b' }, users.a)).status, 200)
  assert.equal(db.prepare('SELECT cancelled_at FROM registrations WHERE activity_id=? AND user_id=?').get(id, 'b').cancelled_at, null)
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {}, users.c)).status, 200)
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {}, users.a)).status, 409)
  assert.equal((await call('/api/activities/' + id + '/register', 'DELETE', null, null)).status, 401)
})

test('活动开始、已确认参加或活动取消后不能自主取消', async () => {
  const started = await activity()
  await call('/api/activities/' + started + '/register', 'POST', {})
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now(), started)
  assert.equal((await call('/api/activities/' + started + '/register', 'DELETE')).status, 409)
  const confirmed = await activity()
  await call('/api/activities/' + confirmed + '/register', 'POST', {})
  db.prepare("UPDATE registrations SET confirmed_at=?,confirmed_by='admin',credited_hours=1.5 WHERE activity_id=? AND user_id='a'").run(Date.now(), confirmed)
  assert.equal((await call('/api/activities/' + confirmed + '/register', 'DELETE')).status, 409)
  const cancelled = await activity()
  await call('/api/activities/' + cancelled + '/register', 'POST', {})
  await call('/api/admin/activities/' + cancelled, 'DELETE', null, admin)
  assert.equal((await call('/api/activities/' + cancelled + '/register', 'DELETE')).status, 409)
  for (const id of [started, confirmed, cancelled])
    assert.equal(db.prepare('SELECT cancelled_at FROM registrations WHERE activity_id=? AND user_id=?').get(id, 'a').cancelled_at, null)
})

test('取消后不能签到、确认参加或通过平台经历认定，历史导出显示取消状态', async () => {
  const id = await activity()
  await call('/api/activities/' + id + '/register', 'POST', {})
  const opened = await call('/api/admin/activities/' + id + '/attendance/in', 'POST', { method: 'qr' }, admin)
  await call('/api/activities/' + id + '/register', 'DELETE')
  assert.equal((await call('/api/activities/' + id + '/attendance/in', 'POST', { qrText: opened.body.qrText })).status, 403)
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 1000, id)
  assert.equal((await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: 'a' }, admin)).status, 409)
  assert.equal((await call('/api/experiences', 'POST', { activityId: id, description: '不能提交' })).status, 409)
  const pending = db.prepare("INSERT INTO experiences(user_id,activity_id,title,organizer,occurred_on,description,created_at) VALUES('a',?,'旧经历','平台','2026-01-01','旧待审',?)").run(id, Date.now())
  assert.equal((await call('/api/admin/experiences/' + pending.lastInsertRowid + '/review', 'POST', { status: 'approved' }, admin)).status, 409)
  const person = (await call('/api/admin/people?q=a&limit=100', 'GET', null, admin)).body.rows.find(row => row.id === 'a')
  assert.ok(person.withdrawnCount >= 1)
  assert.equal(person.historicalRegisteredCount, person.registeredCount + person.withdrawnCount)
  const response = await fetch(base + '/api/admin/exports/people?id=a', { headers: { authorization: 'Bearer ' + admin } })
  assert.equal(response.status, 200)
  const workbook = new (require('exceljs').Workbook)()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
  const rows = workbook.worksheets[1].getRows(2, workbook.worksheets[1].rowCount - 1)
  assert.ok(rows.some(row => row.getCell(8).value === '已取消报名' && row.getCell(9).value === 0))
})

test('延期后取消会驳回旧待审经历，重新报名后可再次提交且不删除旧经历', async () => {
  const id = await activity()
  await call('/api/activities/' + id + '/register', 'POST', {})
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 1000, id)
  const first = await call('/api/experiences', 'POST', { activityId: id, description: '原培训经历' })
  assert.equal(first.status, 201)
  const postponed = await call('/api/admin/activities/' + id, 'PUT', {
    title: '延期活动', capacity: 1, creditHours: 1.5,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 7200000).toISOString(),
  }, admin)
  assert.equal(postponed.status, 200)
  await call('/api/activities/' + id + '/register', 'DELETE')
  const rejected = db.prepare('SELECT * FROM experiences WHERE id=?').get(first.body.id)
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.review_note, '报名已取消')
  assert.equal(rejected.reviewed_by, null)
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {})).status, 200)
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 1000, id)
  const second = await call('/api/experiences', 'POST', { activityId: id, description: '重新参加后的经历' })
  assert.equal(second.status, 201)
  assert.notEqual(second.body.id, first.body.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM experiences WHERE activity_id=? AND user_id=?').get(id, 'a').n, 2)
})

test('取消后的并发重新报名仍遵守容量且没有重复主键', async () => {
  const id = await activity(5)
  const candidates = Object.entries(users).filter(([name]) => name.startsWith('race'))
  for (let round = 0; round < 2; round++) {
    const results = await Promise.all(candidates.map(([, token]) => call('/api/activities/' + id + '/register', 'POST', {}, token)))
    assert.equal(results.filter(result => result.status === 200).length, 5)
    assert.equal(results.filter(result => result.status === 409).length, 15)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations WHERE activity_id=? AND cancelled_at IS NULL').get(id).n, 5)
    const winners = candidates.filter((_, index) => results[index].status === 200)
    await Promise.all(winners.map(([, token]) => call('/api/activities/' + id + '/register', 'DELETE', null, token)))
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations WHERE activity_id=? AND cancelled_at IS NULL').get(id).n, 0)
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM (SELECT user_id FROM registrations WHERE activity_id=? GROUP BY user_id HAVING COUNT(*)>1)').get(id).n, 0)
})

test('增加取消字段保留原值，重复初始化可重入', () => {
  const old = new DatabaseSync(':memory:')
  try {
    old.exec(`CREATE TABLE registrations(activity_id INTEGER,user_id TEXT,registered_at INTEGER,confirmed_at INTEGER,confirmed_by TEXT,credited_hours REAL);
      INSERT INTO registrations VALUES(1,'a',123,NULL,NULL,0);`)
    ensureRegistrationSchema(old)
    ensureRegistrationSchema(old)
    const record = old.prepare('SELECT * FROM registrations').get()
    assert.equal(record.registered_at, 123)
    assert.equal(record.cancelled_at, null)
    assert.equal(old.prepare('PRAGMA table_info(registrations)').all().filter(row => row.name === 'cancelled_at').length, 1)
  } finally { old.close() }
})

test('取得写锁后复核权限，撤销权限不会留下报名或取消写入', async () => {
  const id = await activity()
  const service = createRegistration(db)
  const revoked = () => { throw Object.assign(new Error('会话已撤销'), { status: 401 }) }
  assert.throws(() => service.register(id, 'a', revoked), { status: 401 })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations WHERE activity_id=?').get(id).n, 0)
  service.register(id, 'a')
  assert.throws(() => service.cancel(id, 'a', revoked), { status: 401 })
  assert.equal(db.prepare('SELECT cancelled_at FROM registrations WHERE activity_id=?').get(id).cancelled_at, null)
})
