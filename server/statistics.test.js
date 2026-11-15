process.env.DB_PATH=':memory:'
process.env.NODE_ENV='test'
process.env.ENABLE_DEV_LOGIN='1'
process.env.DEV_ADMIN_ID='admin'
const {test,before,after}=require('node:test')
const assert=require('node:assert/strict')
const {server,db}=require('./server')
let base,admin,user
async function call(route,token=admin){
  const response=await fetch(base+route,{headers:token?{authorization:'Bearer '+token}:{}})
  return {status:response.status,body:await response.json()}
}
const summary=(dimension,extra='')=>call('/api/admin/statistics?year=2025&dimension='+dimension+'&limit=20'+extra)
before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port
  const login=async id=>{
    const response=await fetch(base+'/api/auth/dev',{method:'POST',body:JSON.stringify({id,name:id,department:'学院'})})
    return(await response.json()).token
  }
  admin=await login('admin')
  for(const [id,name,department]of[['c1','老师甲','学院A'],['c2','老师乙','学院B'],['c3','零记录','学院A']])
    db.prepare("INSERT INTO users(id,name,department,role) VALUES(?,?,?,'counselor')").run(id,name,department)
  // Existing names are intentionally not dev-login names; issue an isolated test session.
  user='c'.repeat(64)
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(require('node:crypto').createHash('sha256').update(user).digest('hex'),'c1',Date.now()+3600000)
  const start=Date.parse('2024-12-31T16:00:00Z')
  for(let id=1;id<=4;id++)db.prepare('INSERT INTO activities(id,title,description,location,starts_at,ends_at,capacity,credit_hours,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,'平台活动'+id,'','现场',start+(id-1)*86400000,start+(id-1)*86400000+3600000,0,id===1?1.5:3,id===2?'cancelled':'published',start)
  const registration=db.prepare('INSERT INTO registrations(activity_id,user_id,registered_at,confirmed_at,credited_hours,cancelled_at) VALUES(?,?,?,?,?,?)')
  registration.run(1,'c1',start,start,1.5,null)
  registration.run(1,'c2',start,null,0,start)
  registration.run(2,'c1',start,start,3,null)
  registration.run(4,'c1',start,null,0,null)
  for(const [status,created]of[['rejected',1],['pending',2]])db.prepare("INSERT INTO experiences(user_id,activity_id,title,organizer,occurred_on,description,status,created_at) VALUES('c1',4,'平台活动4','平台','2025-01-04','经历',?,?)").run(status,created)
  const external=db.prepare('INSERT INTO external_trainings(user_id,title,organizer,occurred_on,requested_hours,description,status,credited_hours,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  external.run('c1','共同培训','校外主办方','2025-02-01',2,'参加','approved',2,start)
  external.run('c2','共同培训','校外主办方','2025-02-01',2,'参加','approved',2,start)
  external.run('c2','驳回培训','其他主办方','2025-03-01',9,'待补正','rejected',0,start)
})
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()})

test('统一统计仅管理员可读或导出，参数错误不进入SQL',async()=>{
  for(const route of ['/api/admin/statistics','/api/admin/statistics/records','/api/admin/exports/statistics'])assert.equal((await call(route,user)).status,403)
  assert.equal((await call('/api/admin/statistics',null)).status,401)
  assert.equal((await summary('unknown')).status,400)
  assert.equal((await call('/api/admin/statistics?year=bad')).status,400)
  assert.equal((await summary('activity','&key=platform:1%20OR%201=1')).status,400)
  const injected=await summary('counselor','&q='+encodeURIComponent("' OR 1=1 --"))
  assert.equal(injected.body.total,0)
})

test('按活动含零报名活动，同名主办方日期的自行培训合并，取消和驳回不计时',async()=>{
  const result=await summary('activity')
  assert.equal(result.status,200)
  assert.equal(result.body.total,6)
  assert.equal(result.body.totals.recordCount,7)
  assert.equal(result.body.totals.attendedCount,3)
  assert.equal(result.body.totals.pendingCount,1)
  assert.equal(result.body.totals.rejectedCount,1)
  assert.equal(result.body.totals.cancelledCount,2)
  assert.equal(result.body.totals.totalHours,5.5)
  assert.equal(result.body.rows.find(row=>row.key==='platform:3').recordCount,0)
  const group=result.body.rows.find(row=>row.name==='共同培训')
  assert.equal(group.recordCount,2);assert.equal(group.totalHours,4)
  const detail=await call('/api/admin/statistics/records?year=2025&dimension=activity&key='+encodeURIComponent(group.key)+'&limit=1')
  assert.equal(detail.body.total,2);assert.equal(detail.body.rows.length,1)
  assert.equal(detail.body.rows[0].recognizedHours,2)
})

test('按辅导员和学院汇总相同事实，零记录人员保留且分页不改变总计',async()=>{
  const people=await summary('counselor')
  assert.equal(people.body.rows.find(row=>row.key==='c1').totalHours,3.5)
  const personal=await call('/api/my/annual?year=2025&limit=20',user)
  const existingRank=await call('/api/admin/ranking?year=2025')
  assert.equal(personal.body.totalHours,people.body.rows.find(row=>row.key==='c1').totalHours)
  assert.equal(existingRank.body.rows.find(row=>row.id==='c1').totalHours,personal.body.totalHours)
  assert.equal(people.body.rows.find(row=>row.key==='c3').recordCount,0)
  const colleges=await summary('department')
  const a=colleges.body.rows.find(row=>row.key==='学院A')
  assert.equal(a.counselorCount,2);assert.equal(a.attendedCount,2);assert.equal(a.totalHours,3.5)
  const detail=await call('/api/admin/statistics/records?year=2025&dimension=department&key='+encodeURIComponent('学院A'))
  assert.equal(detail.body.total,4)
  assert.ok(detail.body.rows.every(row=>row.department==='学院A'))
  const page=await call('/api/admin/statistics?year=2025&dimension=counselor&limit=1&offset=1')
  assert.equal(page.body.rows.length,1);assert.equal(page.body.totals.totalHours,5.5)
})

test('年度排行保留全局名次，搜索不重排名次，日期按北京时间归年',async()=>{
  const all=await summary('ranking')
  assert.equal(all.body.rows[0].key,'c1');assert.equal(all.body.rows[0].rank,1)
  const found=await summary('ranking','&q=c2')
  assert.equal(found.body.rows.length,1);assert.equal(found.body.rows[0].rank,2)
  const before=await call('/api/admin/statistics?dimension=activity&year=2024')
  assert.equal(before.body.total,0)
})

test('相同学时并列，学院过滤和搜索仍保留全校年度名次',async()=>{
  const result=db.prepare("INSERT INTO external_trainings(user_id,title,organizer,occurred_on,requested_hours,description,status,credited_hours,created_at) VALUES('c3','并列培训','主办方','2025-06-01',2,'参加','approved',2,1)").run()
  try{
    const ranked=await summary('ranking')
    assert.equal(ranked.body.rows.find(row=>row.key==='c2').rank,2)
    assert.equal(ranked.body.rows.find(row=>row.key==='c3').rank,2)
    const selected=await summary('ranking','&department='+encodeURIComponent('学院A')+'&q=c3')
    assert.equal(selected.body.rows[0].rank,2)
    assert.equal(selected.body.rows[0].totalHours,2)
  }finally{db.prepare('DELETE FROM external_trainings WHERE id=?').run(result.lastInsertRowid)}
})

test('导出包含筛选的完整汇总和参加明细，不按当前页截取',async()=>{
  const response=await fetch(base+'/api/admin/exports/statistics?dimension=department&year=2025&key='+encodeURIComponent('学院A')+'&limit=1',{headers:{authorization:'Bearer '+admin}})
  assert.equal(response.status,200)
  const book=new(require('exceljs').Workbook)()
  await book.xlsx.load(Buffer.from(await response.arrayBuffer()))
  assert.equal(book.worksheets.length,2)
  assert.equal(book.worksheets[0].rowCount,2)
  assert.equal(book.worksheets[1].rowCount,5)
  const headers=book.worksheets[0].getRow(1).values
  const column=headers.indexOf('认定学时')
  assert.equal(book.worksheets[0].getCell(2,column).value,3.5)
  const missing=await call('/api/admin/statistics/records?dimension=counselor&year=2025&key=missing')
  assert.equal(missing.status,404)
})
