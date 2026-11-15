process.env.DB_PATH=':memory:'
process.env.ENABLE_DEV_LOGIN='1'
process.env.DEV_ADMIN_ID='admin'
const {test,before,after}=require('node:test')
const assert=require('node:assert/strict')
const {server,db}=require('./server')
let base,admin,alice,bob
async function call(route,method='GET',body,token=alice){
  const response=await fetch(base+route,{method,headers:token?{authorization:'Bearer '+token}:{},...(body?{body:JSON.stringify(body)}:{})})
  return {status:response.status,body:await response.json()}
}
async function login(id){return(await call('/api/auth/dev','POST',{id,name:id,department:'学院'},null)).body.token}
before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port
  admin=await login('admin');alice=await login('alice');bob=await login('bob')
})
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()})

test('发布、报名、取消、恢复经真实接口产生站内通知，读取限定当前账号',async()=>{
  const activity=await call('/api/admin/activities','POST',{title:'站内通知集成',startsAt:new Date(Date.now()+3600000).toISOString(),endsAt:new Date(Date.now()+7200000).toISOString(),creditHours:1.5},admin)
  assert.equal(activity.status,201)
  const id=activity.body.id
  const list=await call('/api/notifications?limit=20&userId=bob')
  assert.equal(list.body.total,1);assert.equal(list.body.rows[0].kind,'activity.published')
  assert.equal((await call('/api/notifications/unread-count')).body.unreadCount,1)
  const bobMessage=(await call('/api/notifications?limit=20','GET',null,bob)).body.rows[0].id
  assert.equal((await call('/api/notifications/'+bobMessage+'/read','POST',{})).status,404)
  assert.equal((await call('/api/activities/'+id+'/register','POST',{})).status,200)
  assert.equal((await call('/api/activities/'+id+'/register','DELETE')).status,200)
  assert.equal((await call('/api/activities/'+id+'/register','POST',{})).status,200)
  const updated=await call('/api/notifications?limit=20')
  assert.equal(updated.body.total,4)
  assert.equal(updated.body.rows.filter(row=>row.kind==='registration.cancelled').length,1)
  const opened=await call('/api/notifications/'+list.body.rows[0].id+'/read','POST',{})
  assert.equal(opened.body.target.url,'/pages/course/detail?id='+id)
  assert.equal(opened.body.unreadCount,3)
  const all=await call('/api/notifications/read-all','POST',{userId:'bob'})
  assert.equal(all.body.unreadCount,0)
  assert.equal((await call('/api/notifications/unread-count','GET',null,bob)).body.unreadCount,1)
  const logged=db.prepare("SELECT actor_id FROM audit_logs WHERE action='notifications.update' ORDER BY id DESC LIMIT 1").get()
  assert.equal(logged.actor_id,'alice')
  assert.equal((await call('/api/notifications','GET',null,null)).status,401)
})

test('审核通知与业务同事务，初始密码不能绕过限制读取消息',async()=>{
  const created=await call('/api/admin/users','POST',{id:'initial',name:'初始化',department:'学院',initialPassword:'Initial-Password-2026'},admin)
  assert.equal(created.status,201)
  const token=(await call('/api/auth/login','POST',{id:'initial',password:'Initial-Password-2026'},null)).body.token
  assert.equal((await call('/api/notifications','GET',null,token)).body.code,'PASSWORD_CHANGE_REQUIRED')
  const before=db.prepare('SELECT COUNT(*) n FROM notifications').get().n
  db.exec("CREATE TRIGGER simulate_notification_failure BEFORE INSERT ON notifications WHEN NEW.kind='activity.published' BEGIN SELECT RAISE(ABORT,'notification unavailable');END")
  const previousError=console.error
  try{
    console.error=()=>{}
    const result=await call('/api/admin/activities','POST',{title:'不应残留',startsAt:new Date(Date.now()+3600000).toISOString(),endsAt:new Date(Date.now()+7200000).toISOString(),creditHours:1.5},admin)
    assert.equal(result.status,500)
  }finally{console.error=previousError;db.exec('DROP TRIGGER simulate_notification_failure')}
  assert.equal(db.prepare("SELECT id FROM activities WHERE title='不应残留'").get(),undefined)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n,before)
})
