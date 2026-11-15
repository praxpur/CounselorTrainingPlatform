const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'training-evidence-'))
process.env.DB_PATH = ':memory:'
process.env.UPLOAD_DIR = uploadRoot
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { server, db } = require('./server')
let base, admin, user, other
const pdf = Buffer.from('%PDF-1.4\nProof fixture\n%%EOF')
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10)
const form = { title: '校外培训', organizer: '主办方', occurredOn: today, requestedHours: 1.5, description: '参加培训并学习交流' }
async function call(route, method = 'GET', body, token = user) {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
async function upload(token = user, body = pdf, name = '参加证明.pdf') {
  const response = await fetch(base + '/api/proofs', { method: 'POST', body, headers: { authorization: 'Bearer ' + token, 'x-file-name': encodeURIComponent(name) } })
  return { status: response.status, body: await response.json() }
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  admin = (await call('/api/auth/dev', 'POST', { id: 'admin', name: '管理员', department: '学院' }, null)).body.token
  user = (await call('/api/auth/dev', 'POST', { id: 'u1', name: '老师', department: '学院' }, null)).body.token
  other = (await call('/api/auth/dev', 'POST', { id: 'u2', name: '他人', department: '学院' }, null)).body.token
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
  fs.rmSync(uploadRoot, { recursive: true, force: true })
})

test('证明材料检测文件内容，下载限本人和管理员且不公开缓存', async () => {
  assert.equal((await upload(admin)).status, 403)
  assert.equal((await upload(user, Buffer.from('<html>bad</html>'))).status, 400)
  assert.equal((await upload(user, pdf, 'bad\nname.pdf')).status, 400)
  const created = await upload()
  assert.equal(created.status, 201)
  assert.equal(created.body.mimeType, 'application/pdf')
  const id = created.body.id
  for (const token of [user, admin]) {
    const response = await fetch(base + '/api/proofs/' + id, { headers: { authorization: 'Bearer ' + token } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf)
  }
  assert.equal((await call('/api/proofs/' + id, 'GET', null, other)).status, 404)
  assert.equal((await call('/api/proofs/' + id, 'GET', null, null)).status, 401)
})

test('上传超限立即返回 413，不等待整个材料发送完', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM proof_files').get().n
  await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/proofs', { method: 'POST', headers: {
      authorization: 'Bearer ' + user, 'x-file-name': 'proof.pdf', 'content-length': 6 * 1024 * 1024,
    } }, response => {
      assert.equal(response.statusCode, 413)
      assert.equal(response.headers.connection, 'close')
      response.resume(); response.on('end', resolve)
    })
    request.on('error', reject)
    request.setTimeout(2000, () => request.destroy(new Error('超限上传仍在等待结束')))
    request.write('x')
  })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proof_files').get().n, before)
})

test('自行培训须本人材料；审批一次入账，个人汇总、排名和导出保持一致', async () => {
  const file = (await upload()).body
  assert.equal((await call('/api/my/external-trainings', 'POST', { ...form, proofIds: [] })).status, 400)
  assert.equal((await call('/api/my/external-trainings', 'POST', { ...form, proofIds: [file.id] }, other)).status, 403)
  assert.equal((await call('/api/my/external-trainings', 'POST', { ...form, occurredOn: '2999-01-01', proofIds: [file.id] })).status, 400)
  const result = await call('/api/my/external-trainings', 'POST', { ...form, proofIds: [file.id] })
  assert.equal(result.status, 201)
  const id = result.body.id
  assert.equal((await call('/api/my/external-trainings/' + id, 'GET', null, other)).status, 404)
  assert.equal((await call('/api/my/external-trainings/' + id, 'PUT', { ...form, proofIds: [file.id] })).status, 409)
  const secondFile = (await upload()).body
  assert.equal((await call('/api/my/external-trainings', 'POST', { ...form, proofIds: [secondFile.id] })).status, 409)
  const pending = await call('/api/admin/review-count', 'GET', null, admin)
  assert.equal(pending.body.pendingCount, 1)
  assert.equal((await call('/api/admin/external-trainings/' + id + '/review', 'POST', { status: 'approved', creditHours: 2.25 })).status, 403)
  assert.equal((await call('/api/admin/external-trainings/' + id + '/review', 'POST', { status: 'approved' }, admin)).status, 400)
  assert.equal((await call('/api/admin/external-trainings/' + id + '/review', 'POST', { status: 'approved', creditHours: 2.25 }, admin)).status, 200)
  assert.equal((await call('/api/admin/external-trainings/' + id + '/review', 'POST', { status: 'approved', creditHours: 2.25 }, admin)).status, 409)
  const year = today.slice(0,4)
  const report = await call('/api/my/annual?year=' + year)
  assert.equal(report.body.totalHours, 2.25)
  assert.equal(report.body.records[0].proofs[0].id, file.id)
  const ranking = await call('/api/admin/ranking?year=' + year, 'GET', null, admin)
  assert.equal(ranking.body.rows.find(row => row.id === 'u1').totalHours, 2.25)
  const response = await fetch(base + '/api/my/exports/annual?year=' + year, { headers: { authorization: 'Bearer ' + user } })
  const workbook = new (require('exceljs').Workbook)()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
  assert.equal(workbook.worksheets[0].getCell('J2').value, 2.25)
  const people = await call('/api/admin/people', 'GET', null, admin)
  assert.equal(people.body.find(row => row.id === 'u1').externalApprovedCount, 1)
  const peopleExport = await fetch(base + '/api/admin/exports/people', { headers: { authorization: 'Bearer ' + admin } })
  const all = new (require('exceljs').Workbook)()
  await all.xlsx.load(Buffer.from(await peopleExport.arrayBuffer()))
  assert.equal(all.worksheets[2].name, '自行提交活动')
})

test('驳回后在同一记录上重提，保留材料归属并避免重复计时', async () => {
  const file = (await upload()).body, body = { ...form, title: '第二次培训', proofIds: [file.id] }
  const created = await call('/api/my/external-trainings', 'POST', body)
  const id = created.body.id
  assert.equal((await call('/api/admin/external-trainings/' + id + '/review', 'POST', { status: 'rejected', note: '请补充说明' }, admin)).status, 200)
  assert.equal((await call('/api/my/external-trainings/' + id, 'PUT', { ...body, description: '已补充说明' })).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM external_trainings WHERE id=?').get(id).n, 1)
  assert.equal((await call('/api/admin/external-trainings/' + id + '/review', 'POST', { status: 'approved', creditHours: 1.5 }, admin)).status, 200)
  assert.equal((await call('/api/my/annual?year=' + today.slice(0,4))).body.totalHours, 3.75)
})

test('平台培训经历可附材料，驳回后可重用同活动材料', async () => {
  const activity = await call('/api/admin/activities', 'POST', {
    title: '平台活动', startsAt: new Date(Date.now() + 3600000).toISOString(), endsAt: new Date(Date.now() + 7200000).toISOString(), creditHours: 1.5,
  }, admin)
  const id = activity.body.id
  await call('/api/activities/' + id + '/register', 'POST', {})
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(Date.now() - 1000, id)
  const file = (await upload()).body, body = { activityId: id, description: '培训经历', proofIds: [file.id] }
  const first = await call('/api/experiences', 'POST', body)
  assert.equal(first.status, 201)
  await call('/api/admin/experiences/' + first.body.id + '/review', 'POST', { status: 'rejected', note: '补充说明' }, admin)
  const second = await call('/api/experiences', 'POST', body)
  assert.equal(second.status, 201)
  const reviews = await call('/api/admin/experiences', 'GET', null, admin)
  assert.equal(reviews.body.find(record => record.id === second.body.id).proofs[0].id, file.id)
  assert.equal((await call('/api/admin/experiences/' + second.body.id + '/review', 'POST', { status: 'approved', creditHours: 999 }, admin)).status, 200)
  assert.equal((await call('/api/my/annual?year=' + today.slice(0,4))).body.totalHours, 5.25)
})

test('平台活动和自行培训之间阻止同人同日同名活动重复计时', async () => {
  const insert = db.prepare("INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES(?,'','',?,?,0,1.5,?)")
  const now = Date.now(), start = now - 1000
  const id = Number(insert.run(form.title, start, now + 3600000, now).lastInsertRowid)
  db.prepare("INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,'u1',?)").run(id, now)
  assert.equal((await call('/api/admin/activities/' + id + '/confirm', 'POST', { userId: 'u1' }, admin)).status, 409)
  const another = Number(insert.run('已报名平台活动', start, now + 3600000, now).lastInsertRowid)
  db.prepare("INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,'u1',?)").run(another, now)
  const file = (await upload()).body
  assert.equal((await call('/api/my/external-trainings', 'POST', { ...form, title: '已报名平台活动', proofIds: [file.id] })).status, 409)
})

test('重提移除旧附件仍保留曾提交标记，新上传未使用材料才可进入清理候选',async()=>{
  const oldFile=(await upload()).body
  assert.equal(db.prepare('SELECT ever_submitted FROM proof_files WHERE id=?').get(oldFile.id).ever_submitted,0)
  const body={...form,title:'材料更换',proofIds:[oldFile.id]}
  const created=await call('/api/my/external-trainings','POST',body)
  const id=created.body.id
  await call('/api/admin/external-trainings/'+id+'/review','POST',{status:'rejected',note:'更换证明'},admin)
  const next=(await upload()).body
  assert.equal((await call('/api/my/external-trainings/'+id,'PUT',{...body,proofIds:[next.id]})).status,200)
  const previous=db.prepare('SELECT external_id,ever_submitted FROM proof_files WHERE id=?').get(oldFile.id)
  assert.equal(previous.external_id,null);assert.equal(previous.ever_submitted,1)
  assert.ok(fs.existsSync(path.join(uploadRoot,oldFile.id)))
  assert.equal(db.prepare('SELECT ever_submitted FROM proof_files WHERE id=?').get(next.id).ever_submitted,1)
})

test('旧材料升级保守保留且可重入，后续未使用的新材料仍可清理',()=>{
  const legacy=new(require('node:sqlite').DatabaseSync)(':memory:')
  try{
    legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE experiences(id INTEGER PRIMARY KEY);
      CREATE TABLE proof_files(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,mime_type TEXT,bytes INTEGER,created_at INTEGER,external_id INTEGER,experience_id INTEGER);
      INSERT INTO users VALUES('owner');`)
    const oldId='a'.repeat(48),newId='b'.repeat(48)
    legacy.prepare("INSERT INTO proof_files VALUES(?,'owner','旧材料','application/pdf',10,1,NULL,NULL)").run(oldId)
    const evidence=require('./evidence').createEvidence(legacy)
    evidence.preserveExistingProofs()
    assert.equal(legacy.prepare('SELECT ever_submitted FROM proof_files WHERE id=?').get(oldId).ever_submitted,1)
    legacy.prepare("INSERT INTO proof_files(id,user_id,name,mime_type,bytes,created_at) VALUES(?,'owner','新材料','application/pdf',10,1)").run(newId)
    evidence.preserveExistingProofs()
    assert.equal(legacy.prepare('SELECT ever_submitted FROM proof_files WHERE id=?').get(newId).ever_submitted,0)
  }finally{legacy.close()}
})

test('材料有个人配额，上传中停用账号不留文件或数据库记录', async () => {
  const insert = db.prepare('INSERT INTO proof_files(id,user_id,name,mime_type,bytes,created_at) VALUES(?,?,?,?,?,?)')
  for (let index = 0; index < 100; index++) insert.run(require('node:crypto').randomBytes(24).toString('hex'), 'u1', 'quota-fixture', 'application/pdf', 1, Date.now())
  assert.equal((await upload()).status, 409)
  db.prepare("DELETE FROM proof_files WHERE name='quota-fixture'").run()
  const count = db.prepare('SELECT COUNT(*) n FROM proof_files').get().n
  let request
  const response = new Promise((resolve, reject) => {
    request = http.request(base + '/api/proofs', { method: 'POST', headers: {
      authorization: 'Bearer ' + user, 'x-file-name': 'proof.pdf', 'content-length': pdf.length,
    } }, result => { result.resume(); result.on('end', () => resolve(result.statusCode)) })
    request.on('error', reject)
    request.write(pdf.subarray(0,8))
  })
  await call('/health', 'GET', null, admin)
  await call('/api/admin/users/u1', 'PUT', { name: '老师', department: '学院', enabled: 0 }, admin)
  request.end(pdf.subarray(8))
  assert.equal(await response, 401)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proof_files').get().n, count)
  assert.equal(fs.readdirSync(uploadRoot).length, count)
})
