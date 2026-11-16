const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')
const scratch = path.join(__dirname, '../tmp')
fs.mkdirSync(scratch, { recursive: true })
const root = fs.mkdtempSync(path.join(scratch, 'audit-business-'))
const file = path.join(root, 'test.db')
process.env.DB_PATH = file
process.env.UPLOAD_DIR = path.join(root, 'uploads')
process.env.NODE_ENV = 'test'
const { server, db } = require('./server')
const { importRoster, resetPassword } = require('./roster')
const { encodePassword } = require('./auth')
const actorToken = 'a'.repeat(64), userToken = 'b'.repeat(64)
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
let base, nextId = 100
const now = Date.now()
function event(title = '培训') {
  const id = nextId++
  db.prepare("INSERT INTO activities VALUES(?,?,?,?,?,?,?,'published',?,?)").run(id,title,'介绍','地点',now-3600000,now+3600000,0,now,2)
  return id
}
function session() {
  db.prepare("UPDATE users SET role='admin',enabled=1 WHERE id='actor'").run()
  db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?)').run(digest(actorToken),'actor',Date.now()+3600000)
}
async function call(route, method, input, token = actorToken) {
  const response = await fetch(base+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(input === undefined ? {} : {body:JSON.stringify(input)})})
  return { status:response.status,body:await response.json() }
}
function inputFor(id, overrides = {}) {
  const a=db.prepare('SELECT * FROM activities WHERE id=?').get(id)
  return {title:a.title,description:a.description,location:a.location,startsAt:new Date(a.starts_at).toISOString(),endsAt:new Date(a.ends_at).toISOString(),creditHours:a.credit_hours,...overrides}
}
before(async () => {
  db.exec("INSERT INTO users VALUES('actor','管理员','部门','admin',1); INSERT INTO users VALUES('teacher','辅导员','学院','counselor',1)")
  session()
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(userToken),'teacher',now+3600000)
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  base='http://127.0.0.1:'+server.address().port
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
  fs.rmSync(root,{recursive:true,force:true})
})

test('已有现场记录禁止推迟开始时间；变更结束时间或地点关闭旧窗口，保留现场记录',async()=>{
  const id=event()
  db.prepare('INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,?,?)').run(id,'teacher',now)
  const opened=await call(`/api/admin/activities/${id}/attendance/in`,'POST',{method:'qr'})
  assert.equal(opened.status,200)
  assert.equal((await call(`/api/activities/${id}/attendance/in`,'POST',{qrText:opened.body.qrText},userToken)).status,200)
  const future=new Date(now+86400000).toISOString()
  assert.equal((await call(`/api/admin/activities/${id}`,'PUT',inputFor(id,{startsAt:future,endsAt:new Date(now+90000000).toISOString()}))).status,409)
  assert.equal((await call(`/api/admin/activities/${id}`,'PUT',inputFor(id,{location:'新地点'}))).status,200)
  assert.ok(db.prepare('SELECT closes_at FROM attendance_sessions WHERE activity_id=?').get(id).closes_at<=Date.now())
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance_records WHERE activity_id=?').get(id).n,1)
})
test('未签到的活动调整时空安排也关闭窗口；签退实时拒绝未来开始的活动',async()=>{
  const id=event()
  assert.equal((await call(`/api/admin/activities/${id}/attendance/in`,'POST',{method:'qr'})).status,200)
  assert.equal((await call(`/api/admin/activities/${id}`,'PUT',inputFor(id,{endsAt:new Date(now+7200000).toISOString()}))).status,200)
  assert.ok(db.prepare('SELECT closes_at FROM attendance_sessions WHERE activity_id=?').get(id).closes_at<=Date.now())
  db.prepare('INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,?,?)').run(id,'teacher',now)
  db.prepare("INSERT INTO attendance_records VALUES(?,?,'in','qr',?,NULL,NULL)").run(id,'teacher',now)
  const out=await call(`/api/admin/activities/${id}/attendance/out`,'POST',{method:'qr'})
  assert.equal(out.status,200)
  // Simulate an existing pre-upgrade window on an already postponed activity.
  db.prepare('UPDATE activities SET starts_at=? WHERE id=?').run(now+86400000,id)
  assert.equal((await call(`/api/activities/${id}/attendance/out`,'POST',{qrText:out.body.qrText},userToken)).status,409)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attendance_records WHERE activity_id=? AND phase='out'").get(id).n,0)
})
test('已认定的平台活动改名冲突时原子拒绝，名称、学时与现场窗口不变',async()=>{
  const id=event('原活动')
  db.prepare('INSERT INTO registrations(activity_id,user_id,registered_at,confirmed_at,confirmed_by,credited_hours) VALUES(?,?,?,?,?,?)').run(id,'teacher',now,now,'actor',2)
  const day=new Date(now-3600000+8*3600000).toISOString().slice(0,10)
  db.prepare("INSERT INTO external_trainings(user_id,title,organizer,occurred_on,requested_hours,description,status,credited_hours,created_at) VALUES('teacher','重复活动','主办方',?,2,'经历','approved',2,?)").run(day,now)
  assert.equal((await call(`/api/admin/activities/${id}`,'PUT',inputFor(id,{title:'重复活动'}))).status,409)
  assert.equal(db.prepare('SELECT title FROM activities WHERE id=?').get(id).title,'原活动')
  assert.equal(db.prepare('SELECT credited_hours FROM registrations WHERE activity_id=?').get(id).credited_hours,2)
  assert.equal(db.prepare("SELECT credited_hours FROM external_trainings WHERE title='重复活动'").get().credited_hours,2)
  assert.equal((await call(`/api/admin/activities/${id}`,'PUT',inputFor(id,{title:'无冲突的新名称'}))).status,200)
})

// A real second WAL connection owns the write lock. Release it only when the
// application attempts BEGIN, after its initial HTTP authorization has passed.
async function revokeWhileWaiting(action, changeRole = false) {
  session()
  const signal=new SharedArrayBuffer(4),state=new Int32Array(signal)
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads')
    const {DatabaseSync}=require('node:sqlite')
    const d=new DatabaseSync(workerData.file)
    d.function('audit_actor',()=> 'operator');d.function('audit_request',()=> 'operator-reset');d.function('audit_now',()=>Date.now())
    d.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;BEGIN IMMEDIATE')
    parentPort.postMessage('locked')
    const state=new Int32Array(workerData.signal)
    if(Atomics.wait(state,0,0,5000)==='timed-out')throw new Error('application did not attempt a write transaction')
    if(workerData.changeRole)d.prepare("UPDATE users SET role='counselor' WHERE id='actor'").run()
    else d.prepare("DELETE FROM sessions WHERE user_id='actor'").run()
    d.exec('COMMIT');d.close()
  `,{eval:true,workerData:{file,signal,changeRole}})
  const completed=new Promise((resolve,reject)=>{worker.once('exit',code=>code===0?resolve():reject(new Error('worker exit '+code)));worker.once('error',reject)})
  await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})
  const original=db.exec
  db.exec=function(sql){if(sql==='BEGIN IMMEDIATE'){Atomics.store(state,0,1);Atomics.notify(state,0)}return original.call(this,sql)}
  try { const result=await action();await completed;return result }
  finally { db.exec=original;await worker.terminate();session() }
}
test('WAL 等锁期间撤销会话后，HTTP 发布不能新增活动',async()=>{
  const count=db.prepare('SELECT COUNT(*) n FROM activities').get().n
  const result=await revokeWhileWaiting(()=>call('/api/admin/activities','POST',{title:'撤销后发布',startsAt:new Date(now+3600000).toISOString(),endsAt:new Date(now+7200000).toISOString(),creditHours:1}))
  assert.equal(result.status,401)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activities').get().n,count)
})
test('WAL 等锁期间管理员降权后，HTTP 修改与关闭签到不能继续写入',async()=>{
  const id=event('原名称')
  assert.equal((await revokeWhileWaiting(()=>call(`/api/admin/activities/${id}`,'PUT',inputFor(id,{title:'越权名称'})),true)).status,403)
  assert.equal(db.prepare('SELECT title FROM activities WHERE id=?').get(id).title,'原名称')
  await call(`/api/admin/activities/${id}/attendance/in`,'POST',{method:'qr'})
  const closes=db.prepare('SELECT closes_at FROM attendance_sessions WHERE activity_id=?').get(id).closes_at
  assert.equal((await revokeWhileWaiting(()=>call(`/api/admin/activities/${id}/attendance/in`,'DELETE'),true)).status,403)
  assert.equal(db.prepare('SELECT closes_at FROM attendance_sessions WHERE activity_id=?').get(id).closes_at,closes)
})
test('WAL 等锁后名单导入与密码重置均在锁内重新授权，默认离线授权仍可使用',async()=>{
  const password=await encodePassword('Original-Password-2026')
  db.prepare('INSERT INTO credentials VALUES(?,?,0)').run('teacher',password)
  const authorize=()=>{
    if(!db.prepare("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.role='admin'").get(digest(actorToken)))throw Object.assign(new Error('revoked'),{status:401})
  }
  await assert.rejects(revokeWhileWaiting(()=>importRoster(db,[{id:'race-import',name:'新教师',department:'学院',initialPassword:'Initial-Password-2026'}],{authorize})),{status:401})
  assert.equal(db.prepare("SELECT id FROM users WHERE id='race-import'").get(),undefined)
  await assert.rejects(revokeWhileWaiting(()=>resetPassword(db,'teacher','Changed-Password-2026',authorize)),{status:401})
  assert.equal(db.prepare("SELECT password_hash FROM credentials WHERE user_id='teacher'").get().password_hash,password)
  assert.deepEqual(await importRoster(db,[{id:'offline-import',name:'教师',department:'学院',initialPassword:'Initial-Password-2026'}]),{imported:1})
})

test('WAL 等锁撤销会话后审核不能入账，异步生成二维码也不能开放窗口',async()=>{
  const id=event('锁内开放')
  assert.equal((await revokeWhileWaiting(()=>call(`/api/admin/activities/${id}/attendance/in`,'POST',{method:'qr'}))).status,401)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance_sessions WHERE activity_id=?').get(id).n,0)
  const record=Number(db.prepare("INSERT INTO external_trainings(user_id,title,organizer,occurred_on,requested_hours,description,created_at) VALUES('teacher','待审核活动','主办方',?,2,'经历',?)").run(new Date(now+8*3600000).toISOString().slice(0,10),now).lastInsertRowid)
  assert.equal((await revokeWhileWaiting(()=>call(`/api/admin/external-trainings/${record}/review`,'POST',{status:'approved',creditHours:2}))).status,401)
  assert.equal(db.prepare('SELECT status,credited_hours FROM external_trainings WHERE id=?').get(record).status,'pending')
  assert.equal(db.prepare('SELECT credited_hours FROM external_trainings WHERE id=?').get(record).credited_hours,0)
})
