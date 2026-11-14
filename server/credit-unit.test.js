process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { migrateCreditUnits } = require('./credit-unit')
const { personalAnnual } = require('./personal')
const { server, db } = require('./server')
let base, admin, user
async function call(path, method = 'GET', body, token = admin) {
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  admin = (await call('/api/auth/dev', 'POST', { id: 'admin', name: '管理员', department: '学院' }, null)).body.token
  user = (await call('/api/auth/dev', 'POST', { id: 'user', name: '辅导员', department: '学院' }, null)).body.token
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
})

test('旧库学时字段原数值迁移，不做换算且可重复执行', () => {
  const legacy = new DatabaseSync(':memory:')
  try {
    legacy.exec(`CREATE TABLE activities(credit_minutes INTEGER); INSERT INTO activities VALUES(60);
      CREATE TABLE registrations(credited_minutes INTEGER); INSERT INTO registrations VALUES(45);
      CREATE TABLE experiences(credit_minutes INTEGER); INSERT INTO experiences VALUES(30);`)
    migrateCreditUnits(legacy)
    migrateCreditUnits(legacy)
    assert.equal(legacy.prepare('SELECT credit_hours value FROM activities').get().value, 60)
    assert.equal(legacy.prepare('SELECT credited_hours value FROM registrations').get().value, 45)
    assert.equal(legacy.prepare('SELECT credit_hours value FROM experiences').get().value, 30)
  } finally { legacy.close() }
})

test('直接录入小数学时，确认、统计与导出保持相同数值', async () => {
  const startsAt = new Date(Date.now() + 3600000).toISOString()
  const endsAt = new Date(Date.now() + 7200000).toISOString()
  const input = { title: '小数学时', startsAt, endsAt, creditHours: 1.5 }
  const created = await call('/api/admin/activities', 'POST', input)
  assert.equal(created.status, 201)
  assert.equal(created.body.creditHours, 1.5)
  assert.equal(created.body.creditMinutes, undefined)
  for (const creditHours of [0.001, false, null, ''])
    assert.equal((await call('/api/admin/activities', 'POST', { ...input, creditHours })).status, 400)
  const id = created.body.id
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {}, user)).status, 200)
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 1000, id)
  assert.equal((await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: 'user' })).status, 200)
  const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
  const report = await call('/api/my/annual?year=' + year, 'GET', null, user)
  assert.equal(report.body.totalHours, 1.5)
  const response = await fetch(base + '/api/my/exports/annual?year=' + year, { headers: { authorization: 'Bearer ' + user } })
  const workbook = new (require('exceljs').Workbook)()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
  assert.equal(workbook.worksheets[0].getCell('J1').value, '认定学时')
  assert.equal(workbook.worksheets[0].getCell('J2').value, 1.5)
})

test('小数学时汇总避免 0.1 + 0.2 的浮点尾差', async () => {
  db.prepare("INSERT INTO users(id,name,department,role) VALUES('fraction','小数','学院','counselor')").run()
  const starts = Date.now() - 1000, year = new Date(starts + 8 * 3600000).getUTCFullYear()
  for (const hours of [0.1, 0.2]) {
    const result = db.prepare("INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES('小数','','',?,?,0,?,?)").run(starts, starts + 10000, hours, starts)
    db.prepare("INSERT INTO registrations(activity_id,user_id,registered_at,confirmed_at,credited_hours) VALUES(?,'fraction',?,?,?)").run(result.lastInsertRowid, starts, starts, hours)
  }
  assert.equal(personalAnnual(db, 'fraction', year).totalHours, 0.3)
  const ranking = await call('/api/admin/ranking?year=' + year)
  assert.equal(ranking.body.rows.find(row => row.id === 'fraction').totalHours, 0.3)
})
