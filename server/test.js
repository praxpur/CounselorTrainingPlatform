process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { server, db } = require('./server')
let base
async function call(path, method = 'GET', data, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  return { status: res.status, body: await res.json() }
}
async function login(id) {
  return (await call('/api/auth/dev', 'POST', { id, name: id, department: '测试学院' })).body.token
}
test('活动管理、权限和并发报名', async () => {
  await new Promise((resolve) =>
    server.listen({ port: 0, host: '127.0.0.1', backlog: 2048 }, resolve),
  )
  base = 'http://127.0.0.1:' + server.address().port
  const admin = await login('admin'),
    user = await login('user')
  assert.equal((await call('/api/admin/review-count', 'GET', null, user)).status, 403)
  assert.equal((await call('/api/admin/review-count', 'GET', null, admin)).body.pendingCount, 0)
  assert.equal((await call('/api/admin/exports/people', 'GET', null, user)).status, 403)
  assert.equal((await call('/api/admin/activities', 'GET', null, user)).status, 403)
  const entry = { id: 'staff001', name: '测试老师', department: '测试学院' }
  assert.equal((await call('/api/admin/users', 'POST', entry, user)).status, 403)
  assert.equal((await call('/api/admin/users', 'POST', entry, admin)).status, 201)
  assert.equal((await call('/api/admin/users', 'POST', entry, admin)).status, 409)
  assert.equal(
    (await call('/api/admin/users', 'POST', { ...entry, id: 'admin' }, admin)).status,
    409,
  )
  const staff = await login('staff001')
  assert.equal((await call('/api/me', 'GET', null, staff)).body.name, '测试老师')
  assert.equal(
    (
      await call(
        '/api/admin/users/staff001',
        'PUT',
        { name: '修改后', department: '新学院', enabled: 0 },
        admin,
      )
    ).status,
    200,
  )
  assert.equal((await call('/api/me', 'GET', null, staff)).status, 401)
  assert.equal(
    (await call('/api/auth/dev', 'POST', { id: 'staff001', name: 'a', department: 'b' })).status,
    403,
  )
  assert.equal(
    (
      await call(
        '/api/admin/users/staff001',
        'PUT',
        { name: '修改后', department: '新学院', enabled: 1 },
        admin,
      )
    ).status,
    200,
  )
  assert.equal((await call('/api/me', 'GET', null, staff)).status, 401)
  assert.equal((await call('/api/admin/users?q=修改后', 'GET', null, admin)).body[0].id, 'staff001')
  const event = {
    title: '培训',
    description: '测试',
    location: '会议室',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    endsAt: new Date(Date.now() + 90000000).toISOString(),
    capacity: 10,
    creditMinutes: 60,
  }
  const created = await call('/api/admin/activities', 'POST', event, admin)
  assert.equal(created.status, 201)
  const id = created.body.id
  const tokens = []
  for (let i = 0; i < 50; i += 25)
    tokens.push(...(await Promise.all(Array.from({ length: 25 }, (_, j) => login('u' + (i + j))))))
  const registrations = await Promise.all(
    tokens.map((t) => call('/api/activities/' + id + '/register', 'POST', {}, t)),
  )
  assert.equal(registrations.filter((x) => x.status === 200).length, 10)
  assert.equal(registrations.filter((x) => x.status === 409).length, 40)
  const attendees = await call('/api/admin/activities/' + id + '/attendees', 'GET', null, admin)
  assert.equal(attendees.body.length, 10)
  const who = attendees.body[0].id
  const repeatToken = tokens[Number(who.slice(1))]
  assert.equal(
    (await call('/api/activities/' + id + '/register', 'POST', {}, repeatToken)).status,
    409,
  )
  const year = new Date(Date.parse(event.startsAt) + 8 * 3600000).getUTCFullYear()
  let rank = await call('/api/admin/ranking?year=' + year, 'GET', null, admin)
  assert.equal(rank.body.rows.find((x) => x.id === who).totalMinutes, 0)
  assert.equal(
    (await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: who }, user)).status,
    403,
  )
  assert.equal(
    (await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: who }, admin)).status,
    409,
  )
  const past = Date.now() - 60000
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(past, id)
  const pastYear = new Date(past + 8 * 3600000).getUTCFullYear()
  const submitted = await call(
    '/api/experiences',
    'POST',
    { activityId: id, description: '培训经历' },
    repeatToken,
  )
  assert.equal(submitted.status, 201)
  assert.equal((await call('/api/admin/review-count', 'GET', null, admin)).body.pendingCount, 1)
  assert.equal(
    (
      await call(
        '/api/experiences',
        'POST',
        { activityId: id, description: '重复提交' },
        repeatToken,
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await call(
        '/api/admin/experiences/' + submitted.body.id + '/review',
        'POST',
        { status: 'approved' },
        user,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await call(
        '/api/admin/experiences/' + submitted.body.id + '/review',
        'POST',
        { status: 'approved', creditMinutes: 500 },
        admin,
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await call(
        '/api/admin/experiences/' + submitted.body.id + '/review',
        'POST',
        { status: 'approved' },
        admin,
      )
    ).status,
    409,
  )
  assert.equal(
    (await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: who }, admin)).status,
    409,
  )
  rank = await call('/api/admin/ranking?year=' + pastYear, 'GET', null, admin)
  assert.equal(rank.body.rows.find((x) => x.id === who).totalMinutes, 60)
  assert.equal(rank.body.rows.find((x) => x.id === who).eventCount, 1)
  assert.equal((await call('/api/admin/review-count', 'GET', null, admin)).body.pendingCount, 0)
  const exportResponse = await fetch(base + '/api/admin/exports/ranking?year=' + pastYear, {
    headers: { authorization: 'Bearer ' + admin },
  })
  assert.equal(exportResponse.status, 200)
  assert.match(exportResponse.headers.get('content-type'), /spreadsheetml/)
  const exported = new ExcelJS.Workbook()
  await exported.xlsx.load(Buffer.from(await exportResponse.arrayBuffer()))
  const rankingSheet = exported.worksheets[0]
  const exportedPerson = rankingSheet
    .getRows(2, rankingSheet.rowCount - 1)
    .find((row) => row.getCell(2).value === who)
  assert.equal(exportedPerson.getCell(6).value, 60)
  assert.equal(exportedPerson.getCell(5).value, 1)
  assert.equal(
    (await call('/api/admin/exports/ranking?year=invalid', 'GET', null, admin)).status,
    400,
  )
  await call(
    '/api/admin/users',
    'POST',
    { id: '00001', name: '=测试姓名', department: '学院' },
    admin,
  )
  const peopleResponse = await fetch(base + '/api/admin/exports/people', {
    headers: { authorization: 'Bearer ' + admin },
  })
  const peopleWorkbook = new ExcelJS.Workbook()
  await peopleWorkbook.xlsx.load(Buffer.from(await peopleResponse.arrayBuffer()))
  assert.equal(peopleWorkbook.worksheets.length, 2)
  const personRow = peopleWorkbook.worksheets[0]
    .getRows(2, peopleWorkbook.worksheets[0].rowCount - 1)
    .find((row) => row.getCell(1).value === '00001')
  assert.equal(personRow.getCell(2).value, '=测试姓名')
  assert.equal(personRow.getCell(4).value, 0)
  assert.equal(peopleWorkbook.worksheets[1].rowCount, 11)
  assert.equal((await call('/api/admin/ranking?year=' + pastYear, 'GET', null, user)).status, 403)
  assert.ok(
    (await call('/api/admin/person-records?id=' + who, 'GET', null, admin)).body[0].confirmedAt,
  )
  assert.equal((await call('/api/admin/people', 'GET', null, user)).status, 403)
  const second = attendees.body[1].id
  assert.equal(
    (await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: second }, admin))
      .status,
    200,
  )
  assert.equal(
    (await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: second }, admin))
      .status,
    409,
  )
  assert.equal(
    (await call('/api/admin/activities/' + id, 'PUT', { ...event, capacity: 9 }, admin)).status,
    409,
  )
  assert.equal((await call('/api/admin/activities/' + id, 'DELETE', null, admin)).status, 200)
  rank = await call('/api/admin/ranking?year=' + pastYear, 'GET', null, admin)
  assert.equal(rank.body.rows.find((x) => x.id === who).totalMinutes, 0)
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {}, user)).status, 409)
  assert.equal(
    (await call('/api/admin/activities/' + id + '/attendees', 'GET', null, admin)).body.length,
    10,
  )
})
after(() => {
  server.close()
  db.close()
})
