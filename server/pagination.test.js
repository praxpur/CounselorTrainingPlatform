process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
process.env.DEV_ADMIN_ID = 'admin'
const { test,before,after }=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const {server,db}=require('./server')
let base,admin,user
const year=2025
async function call(route,token=admin){
  const response=await fetch(base+route,{headers:token?{authorization:'Bearer '+token}:{}})
  return {status:response.status,body:await response.json()}
}
before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  base='http://127.0.0.1:'+server.address().port
  const login=await fetch(base+'/api/auth/dev',{method:'POST',body:JSON.stringify({id:'admin',name:'管理员',department:'学院'})})
  admin=(await login.json()).token
  db.exec('BEGIN IMMEDIATE')
  const addUser=db.prepare("INSERT INTO users(id,name,department,role) VALUES(?,?,?,'counselor')")
  for(let i=0;i<2105;i++){const id='p'+String(i).padStart(5,'0');addUser.run(id,'老师'+id,'学院')}
  user=crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(user).digest('hex'),'p00000',Date.now()+3600000)
  const addActivity=db.prepare("INSERT INTO activities(id,title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES(?,?,'','',?,?,0,?,?)")
  const addRegistration=db.prepare('INSERT INTO registrations(activity_id,user_id,registered_at,confirmed_at,credited_hours) VALUES(?,?,?,?,?)')
  const start=Date.parse('2025-01-01T08:00:00+08:00')
  for(let i=0;i<130;i++){
    const hours=i===0?0.1:i===1?0.2:1
    addActivity.run(i+1,'活动'+i,start+i*1000,start+7200000,hours,start+i)
    addRegistration.run(i+1,'p00000',start,start,hours)
    if(i<2)for(const id of ['p00001','p00002'])addRegistration.run(i+1,id,start,start,hours)
    if(i<20)db.prepare("INSERT INTO experiences(user_id,activity_id,title,organizer,occurred_on,description,created_at) VALUES('p00000',?,'经历','平台','2025-01-01','学习经历',?)").run(i+1,Date.now()+i)
  }
  const external=db.prepare("INSERT INTO external_trainings(user_id,title,organizer,occurred_on,requested_hours,description,status,credited_hours,created_at) VALUES('p00000',?,'主办方',?,?,'自行培训',?,?,?)")
  external.run('年度已认定','2025-01-15',2.25,'approved',2.25,Date.now())
  external.run('年度待审','2025-02-02',5,'pending',0,Date.now())
  external.run('跨年已认定','2024-12-31',7,'approved',7,Date.now())
  for(let i=10;i<115;i++){
    const id='p'+String(i).padStart(5,'0')
    addRegistration.run(1,id,start,null,0)
    db.prepare("INSERT INTO attendance_records VALUES(?,?,'in','qr',?,NULL,NULL)").run(1,id,start+i)
  }
  db.exec('COMMIT')
})
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()})

test('活动逐页读取完整且无重复，分页边界明确拒绝',async()=>{
  const ids=[]
  let offset=0
  do{
    const result=await call('/api/activities?year=2025&limit=31&offset='+offset,user)
    assert.equal(result.status,200);assert.equal(result.body.total,130)
    assert.ok(result.body.rows.length<=31)
    ids.push(...result.body.rows.map(row=>row.id));offset=result.body.nextOffset
  }while(offset!==null)
  assert.equal(ids.length,130);assert.equal(new Set(ids).size,130)
  for(const parameters of ['limit=101','limit=0','limit=1.5','limit=10&offset=-1'])assert.equal((await call('/api/admin/activities?'+parameters)).status,400)
})

test('人员超过旧全量上限时明确报错，分页和搜索仍覆盖全部人员',async()=>{
  const legacy=await call('/api/admin/users')
  assert.equal(legacy.status,400);assert.match(legacy.body.error,/分页/)
  const users=await call('/api/admin/users?limit=100&offset=2000')
  assert.equal(users.body.total,2105);assert.equal(users.body.rows.length,100)
  const found=await call('/api/admin/people?q=p021&limit=2&offset=0')
  assert.equal(found.body.total,5);assert.equal(found.body.rows.length,2);assert.equal(found.body.hasMore,true)
  assert.ok(found.body.rows.every(row=>row.id.startsWith('p021')))
  assert.equal((await call('/api/admin/users?limit=50',user)).status,403)
})

test('年度汇总跨全部明细聚合，页面只返回所选页且不越权',async()=>{
  const report=await call('/api/my/annual?year=2025&limit=10&offset=0',user)
  assert.equal(report.body.records.length,10);assert.equal(report.body.total,132)
  assert.equal(report.body.totalHours,130.55);assert.equal(report.body.approvedCount,131)
  assert.equal(report.body.pendingCount,1);assert.equal(report.body.months[0].hours,130.55)
  const pending=await call('/api/my/records?filter=pending&limit=50',user)
  assert.equal(pending.body.total,1);assert.equal(pending.body.rows[0].title,'年度待审')
  assert.equal((await call('/api/my/records?filter=__proto__&limit=50',user)).status,400)
  const person=await call('/api/admin/person-records?id=p00000&limit=10&offset=10')
  assert.equal(person.body.total,133);assert.equal(person.body.rows.length,10)
  const own=await call('/api/my/records?userId=p00001&limit=10',user)
  assert.equal(own.body.total,133)
})

test('排名跨页使用全局名次，相同学时并列且后续名次正确',async()=>{
  const top=await call('/api/admin/ranking?year=2025&limit=1&offset=0')
  assert.equal(top.body.total,2105);assert.equal(top.body.rows[0].totalHours,130.55)
  assert.equal(top.body.rows[0].rank,1)
  for(const offset of [1,2]){
    const page=await call('/api/admin/ranking?year=2025&limit=1&offset='+offset)
    assert.equal(page.body.rows[0].totalHours,0.3);assert.equal(page.body.rows[0].rank,2)
  }
  assert.equal((await call('/api/admin/ranking?year=2025&limit=1&offset=3')).body.rows[0].rank,4)
})

test('统一审核分页包含两类经历，人员与现场记录均可继续读取',async()=>{
  const first=await call('/api/admin/reviews?status=pending&limit=7&offset=0')
  assert.equal(first.body.total,21);assert.equal(first.body.pendingCount,21);assert.equal(first.body.rows.length,7)
  const ids=[]
  for(let offset=0;offset<21;offset+=7)ids.push(...(await call('/api/admin/reviews?status=pending&limit=7&offset='+offset)).body.rows.map(row=>row.id))
  assert.equal(new Set(ids).size,21);assert.ok(ids.some(id=>id.startsWith('external:')))
  assert.equal((await call('/api/admin/experiences?status=pending&limit=10')).body.total,20)
  const attendees=await call('/api/admin/activities/1/attendees?limit=20&offset=100')
  assert.equal(attendees.body.total,108);assert.equal(attendees.body.rows.length,8)
  const attendance=await call('/api/admin/activities/1/attendance?limit=20&offset=100')
  assert.equal(attendance.body.total,105);assert.equal(attendance.body.records.length,5)
})

test('导出按所选年份和人员筛选，仍保留完整数据与工号',async()=>{
  const response=await fetch(base+'/api/admin/exports/people?year=2025&id=p00001',{headers:{authorization:'Bearer '+admin}})
  assert.equal(response.status,200)
  const workbook=new(require('exceljs').Workbook)()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
  assert.equal(workbook.worksheets[0].rowCount,2)
  assert.equal(workbook.worksheets[0].getCell('A2').value,'p00001')
  assert.equal(workbook.worksheets[1].rowCount,3)
  const search=await fetch(base+'/api/admin/exports/people?year=2025&q=p02104',{headers:{authorization:'Bearer '+admin}})
  assert.equal(search.status,200)
  const filtered=new(require('exceljs').Workbook)()
  await filtered.xlsx.load(Buffer.from(await search.arrayBuffer()))
  assert.equal(filtered.worksheets[0].rowCount,2)
  assert.equal(filtered.worksheets[0].getCell('A2').value,'p02104')
})

test('长文本导致全量 JSON 过大时明确拒绝，逐页仍可访问全部记录',async()=>{
  const start=Date.parse('2025-01-01T08:00:00+08:00')
  const insert=db.prepare("INSERT INTO activities(id,title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES(?,?,'','',?,?,0,1,?)")
  db.exec('BEGIN IMMEDIATE')
  for(let id=131;id<=230;id++)insert.run(id,'长文本'+id,start,start+3600000,start)
  db.prepare('UPDATE activities SET description=?').run('长'.repeat(2000))
  db.exec('COMMIT')
  const all=await call('/api/activities?year=2025',user)
  assert.equal(all.status,413);assert.match(all.body.error,/分页/)
  const page=await call('/api/activities?year=2025&limit=20',user)
  assert.equal(page.status,200);assert.equal(page.body.total,230);assert.equal(page.body.rows.length,20)
})
