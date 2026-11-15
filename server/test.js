process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const http = require('node:http')
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
async function login(id, name = id) {
  return (await call('/api/auth/dev', 'POST', { id, name, department: '测试学院' })).body.token
}
function streamedRequest(route, method, token, payload, splitAt) {
  const bytes = Buffer.from(JSON.stringify(payload))
  const split = splitAt || Math.floor(bytes.length / 2)
  let request
  const result = new Promise((resolve, reject) => {
    request = http.request(
      base + route,
      { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        )
      },
    )
    request.on('error', reject)
    request.write(bytes.subarray(0, split))
  })
  return { result, finish: () => request.end(bytes.subarray(split)) }
}
test('活动管理、权限和并发报名', async () => {
  await new Promise((resolve) =>
    server.listen({ port: 0, host: '127.0.0.1', backlog: 2048 }, resolve),
  )
  base = 'http://127.0.0.1:' + server.address().port
  const admin = await login('admin'),
    user = await login('user')
  assert.equal((await call('/api/auth/dev', 'POST', { id: 'user', name: '错误姓名' })).status, 403)
  const expiredToken = 'a'.repeat(64)
  const expiredHash = require('node:crypto').createHash('sha256').update(expiredToken).digest('hex')
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(expiredHash, 'user', Date.now() - 1000)
  assert.equal((await call('/api/me', 'GET', null, expiredToken)).status, 401)
  const originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  assert.equal((await call('/api/auth/dev', 'POST', { id: 'user', name: 'user' })).status, 404)
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  for (const raw of ['null', '[]', '123', '"invalid"']) {
    const response = await fetch(base + '/api/auth/dev', { method: 'POST', body: raw })
    assert.equal(response.status, 400)
  }
  const oversized = await fetch(base + '/api/auth/dev', {
    method: 'POST',
    body: JSON.stringify({ text: '汉'.repeat(6000) }),
  })
  assert.equal(oversized.status, 413)
  assert.equal((await call('/api/admin/review-count', 'GET', null, user)).status, 403)
  assert.equal((await call('/api/admin/review-count', 'GET', null, admin)).body.pendingCount, 0)
  const firstLogin = await call('/api/auth/dev', 'POST', { id: 'newTeacher', name: '新老师' })
  assert.equal(firstLogin.status, 422)
  assert.equal(firstLogin.body.code, 'DEPARTMENT_REQUIRED')
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get('newTeacher'), undefined)
  assert.equal(
    (
      await call('/api/auth/dev', 'POST', {
        id: 'newTeacher',
        name: '新老师',
        department: '首次填写学院',
      })
    ).status,
    200,
  )
  const secondLogin = await call('/api/auth/dev', 'POST', { id: 'newTeacher', name: '新老师' })
  assert.equal(secondLogin.status, 200)
  assert.equal(secondLogin.body.user.department, '首次填写学院')
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
  const staff = await login('staff001', '测试老师')
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
    creditHours: 60,
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
  assert.ok(
    (await call('/api/activities', 'GET', null, user)).body.some((activity) => activity.id === id),
  )
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
  assert.equal(rank.body.rows.find((x) => x.id === who).totalHours, 0)
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
  assert.ok(
    (await call('/api/activities', 'GET', null, user)).body.some((activity) => activity.id === id),
  )
  const pastYear = new Date(past + 8 * 3600000).getUTCFullYear()
  const beforeSubmission = await call('/api/my/records', 'GET', null, repeatToken)
  assert.equal(beforeSubmission.body[0].reviewStatus, 'unsubmitted')
  const submitted = await call(
    '/api/experiences',
    'POST',
    { activityId: id, description: '培训经历' },
    repeatToken,
  )
  assert.equal(submitted.status, 201)
  const pendingPersonal = await call('/api/my/records', 'GET', null, repeatToken)
  assert.equal(pendingPersonal.body.length, 1)
  assert.equal(pendingPersonal.body[0].reviewStatus, 'pending')
  assert.equal(pendingPersonal.body[0].experience, '培训经历')
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
        { status: 'approved', creditHours: 500 },
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
  assert.equal(rank.body.rows.find((x) => x.id === who).totalHours, 60)
  assert.equal(rank.body.rows.find((x) => x.id === who).eventCount, 1)
  const personalReport = await call('/api/my/annual?year=' + pastYear, 'GET', null, repeatToken)
  assert.equal(personalReport.body.totalHours, 60)
  assert.equal(personalReport.body.approvedCount, 1)
  assert.equal(personalReport.body.records.length, 1)
  assert.equal(
    personalReport.body.months.reduce((sum, month) => sum + month.hours, 0),
    60,
  )
  assert.equal(personalReport.body.records[0].reviewStatus, 'approved')
  const otherPersonal = await call(
    '/api/my/annual?year=' + pastYear + '&userId=' + who,
    'GET',
    null,
    user,
  )
  assert.equal(otherPersonal.body.records.length, 0)
  assert.equal((await call('/api/my/annual?year=invalid', 'GET', null, repeatToken)).status, 400)
  assert.equal((await call('/api/my/records')).status, 401)
  const personalExportResponse = await fetch(base + '/api/my/exports/annual?year=' + pastYear, {
    headers: { authorization: 'Bearer ' + repeatToken },
  })
  assert.equal(personalExportResponse.status, 200)
  const personalWorkbook = new ExcelJS.Workbook()
  await personalWorkbook.xlsx.load(Buffer.from(await personalExportResponse.arrayBuffer()))
  assert.equal(personalWorkbook.worksheets[0].getCell('B2').value, who)
  assert.equal(personalWorkbook.worksheets[0].getCell('J2').value, 60)
  assert.equal(personalWorkbook.worksheets[1].rowCount, 2)
  assert.equal(personalWorkbook.worksheets[1].getCell('E2').value, 60)
  assert.equal(personalWorkbook.worksheets[1].getCell('F2').value, '已审核通过')
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
  assert.equal(personRow.getCell(2).type, ExcelJS.ValueType.String)
  assert.equal(personRow.getCell(2).numFmt, '@')
  assert.equal(personRow.getCell(1).value, '00001')
  assert.equal(personRow.getCell(1).type, ExcelJS.ValueType.String)
  assert.equal(personRow.getCell(1).numFmt, '@')
  assert.equal(personRow.getCell(4).value, 0)
  assert.equal(peopleWorkbook.worksheets[1].rowCount, 11)
  assert.equal((await call('/api/admin/ranking?year=' + pastYear, 'GET', null, user)).status, 403)
  assert.ok(
    (await call('/api/admin/person-records?id=' + who, 'GET', null, admin)).body[0].confirmedAt,
  )
  assert.equal((await call('/api/admin/people', 'GET', null, user)).status, 403)
  const second = attendees.body[1].id
  const secondToken = tokens[Number(second.slice(1))]
  assert.equal(
    (
      await call(
        '/api/experiences',
        'POST',
        { activityId: id, description: '管理员直接确认前的待审经历' },
        secondToken,
      )
    ).status,
    201,
  )
  assert.equal(
    (await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: second }, admin))
      .status,
    200,
  )
  assert.equal((await call('/api/admin/review-count', 'GET', null, admin)).body.pendingCount, 0)
  assert.equal(
    (await call('/api/my/records', 'GET', null, secondToken)).body[0].experienceStatus,
    'approved',
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
  const cancelledPersonal = await call('/api/my/annual?year=' + pastYear, 'GET', null, repeatToken)
  assert.equal(cancelledPersonal.body.totalHours, 0)
  assert.equal(cancelledPersonal.body.records[0].reviewStatus, 'cancelled')
  assert.equal(
    (await call('/api/activities', 'GET', null, user)).body.some((activity) => activity.id === id),
    false,
  )
  rank = await call('/api/admin/ranking?year=' + pastYear, 'GET', null, admin)
  assert.equal(rank.body.rows.find((x) => x.id === who).totalHours, 0)
  assert.equal((await call('/api/activities/' + id + '/register', 'POST', {}, user)).status, 409)
  assert.equal(
    (await call('/api/admin/activities/' + id + '/attendees', 'GET', null, admin)).body.length,
    10,
  )
  const optionalEvent = {
    title: '可选项留空的活动',
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    creditHours: 30,
  }
  const optionalResult = await call('/api/admin/activities', 'POST', optionalEvent, admin)
  assert.equal(optionalResult.status, 201)
  assert.equal(optionalResult.body.capacity, null)
  assert.equal(optionalResult.body.location, '')
  assert.equal(optionalResult.body.description, '')
  const optionalId = optionalResult.body.id
  assert.equal(
    (await call('/api/activities/' + optionalId + '/register', 'POST', {}, user)).status,
    200,
  )
  assert.equal(
    (await call('/api/activities/' + optionalId + '/register', 'POST', {}, tokens[0])).status,
    200,
  )
  assert.ok(
    (await call('/api/activities', 'GET', null, user)).body.some(
      (activity) => activity.id === optionalId,
    ),
  )
  assert.equal(
    (
      await call(
        '/api/admin/activities/' + optionalId,
        'PUT',
        { ...optionalEvent, capacity: null },
        admin,
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await call(
        '/api/admin/activities/' + optionalId,
        'PUT',
        { ...optionalEvent, capacity: 1 },
        admin,
      )
    ).status,
    409,
  )
  for (const invalid of [
    { capacity: 0 },
    { capacity: -1 },
    { capacity: 1.5 },
    { title: '' },
    { creditHours: null },
    { creditHours: false },
    { capacity: true },
    { startsAt: '2026-02-30T10:00:00+08:00' },
    { startsAt: '2026-11-11T24:00:00+08:00' },
    { location: {} },
  ]) {
    assert.equal(
      (await call('/api/admin/activities', 'POST', { ...optionalEvent, ...invalid }, admin)).status,
      400,
    )
  }
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 60000, optionalId)
  const rejectedSubmission = await call(
    '/api/experiences',
    'POST',
    { activityId: optionalId, description: '第一次经历' },
    user,
  )
  assert.equal(
    (
      await call(
        '/api/admin/experiences/' + rejectedSubmission.body.id + '/review',
        'POST',
        { status: 'rejected', note: '请补充内容' },
        admin,
      )
    ).status,
    200,
  )
  const rejectedRecord = (await call('/api/my/records', 'GET', null, user)).body[0]
  assert.equal(rejectedRecord.reviewStatus, 'rejected')
  assert.equal(rejectedRecord.canSubmit, true)
  assert.equal(
    (
      await call(
        '/api/experiences',
        'POST',
        { activityId: optionalId, description: '补充后的经历' },
        user,
      )
    ).status,
    201,
  )
  const resubmittedRecords = (await call('/api/my/records', 'GET', null, user)).body
  assert.equal(resubmittedRecords.length, 1)
  assert.equal(resubmittedRecords[0].reviewStatus, 'pending')
  assert.equal(resubmittedRecords[0].experience, '补充后的经历')
  assert.equal(
    (await call('/api/admin/activities/' + optionalId, 'DELETE', null, admin)).status,
    200,
  )
  assert.equal((await call('/api/admin/review-count', 'GET', null, admin)).body.pendingCount, 0)
  assert.equal((await call('/api/my/records', 'GET', null, user)).body[0].reviewStatus, 'cancelled')
  const { personalAnnual } = require('./personal')
  for (const date of ['2024-12-31T23:30:00+08:00', '2025-01-01T00:30:00+08:00']) {
    const start = Date.parse(date)
    const row = db
      .prepare(
        "INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES('跨年测试','','',?,?,0,45,?)",
      )
      .run(start, start + 3600000, Date.now())
    db.prepare(
      'INSERT INTO registrations(activity_id,user_id,registered_at,confirmed_at,credited_hours) VALUES(?,?,?,?,45)',
    ).run(Number(row.lastInsertRowid), 'staff001', start, start + 3600000)
  }
  const boundaryReport = personalAnnual(db, 'staff001', 2025)
  assert.equal(boundaryReport.records.length, 1)
  assert.equal(boundaryReport.totalHours, 45)
  assert.equal(boundaryReport.months[0].hours, 45)
  const yearActivities = await call('/api/activities?year=2025', 'GET', null, user)
  assert.equal(yearActivities.status, 200)
  assert.equal(yearActivities.body.length, 1)
  assert.equal(yearActivities.body[0].startsAt, Date.parse('2025-01-01T00:30:00+08:00'))
  assert.equal((await call('/api/activities?year=2024', 'GET', null, user)).body.length, 1)
  assert.equal((await call('/api/activities?year=invalid', 'GET', null, user)).status, 400)
  const utf8Payload = { id: 'utf8-user', name: '测试姓名', department: '学院' }
  const utf8Bytes = Buffer.from(JSON.stringify(utf8Payload))
  const utf8Request = streamedRequest(
    '/api/admin/users',
    'POST',
    admin,
    utf8Payload,
    utf8Bytes.indexOf(Buffer.from('测')) + 1,
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  utf8Request.finish()
  assert.equal((await utf8Request.result).body.name, '测试姓名')
  const raceActivity = await call(
    '/api/admin/activities',
    'POST',
    { ...optionalEvent, capacity: 4 },
    admin,
  )
  const raceId = raceActivity.body.id
  const editRequest = streamedRequest('/api/admin/activities/' + raceId, 'PUT', admin, {
    ...optionalEvent,
    capacity: 1,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(
    (await call('/api/activities/' + raceId + '/register', 'POST', {}, user)).status,
    200,
  )
  assert.equal(
    (await call('/api/activities/' + raceId + '/register', 'POST', {}, tokens[0])).status,
    200,
  )
  editRequest.finish()
  assert.equal((await editRequest.result).status, 409)
  assert.equal(db.prepare('SELECT capacity FROM activities WHERE id=?').get(raceId).capacity, 4)
  const staffToken = await login('staff001', '修改后')
  assert.equal(
    (await call('/api/activities/' + raceId + '/register', 'POST', {}, staffToken)).status,
    200,
  )
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 60000, raceId)
  const disabledRequest = streamedRequest('/api/experiences', 'POST', staffToken, {
    activityId: raceId,
    description: '停用期间不能提交',
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
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
  disabledRequest.finish()
  assert.equal((await disabledRequest.result).status, 401)
  assert.equal(
    db
      .prepare("SELECT COUNT(*) count FROM experiences WHERE user_id='staff001' AND activity_id=?")
      .get(raceId).count,
    0,
  )
  for (let index = 0; index < 1001; index++)
    db.prepare("INSERT INTO users(id,name,department,role) VALUES(?,?,?,'counselor')").run(
      'bulk-' + index,
      '批量测试' + index,
      '测试学院',
    )
  assert.ok((await call('/api/admin/users', 'GET', null, admin)).body.length > 1000)
  assert.ok((await call('/api/admin/people', 'GET', null, admin)).body.length > 1000)
})
after(() => {
  server.close()
  db.close()
})
