const {test}=require('node:test')
const assert=require('node:assert/strict')
const {DatabaseSync}=require('node:sqlite')
const {clientIp}=require('./client-ip')
const {createAuthentication,encodePassword}=require('./auth')
const request=(peer,header)=>({socket:{remoteAddress:peer},headers:header===undefined?{}:{'x-real-ip':header}})
test('只有显式信任的回环代理可传递单一真实IP，普通客户端不能伪造',()=>{
  assert.equal(clientIp(request('192.0.2.1','198.51.100.2'),'none'),'192.0.2.1')
  assert.equal(clientIp(request('192.0.2.1','198.51.100.2'),'loopback'),'192.0.2.1')
  assert.equal(clientIp(request('127.0.0.1','198.51.100.2'),'loopback'),'198.51.100.2')
  assert.equal(clientIp(request('::ffff:127.0.0.1','2001:db8::2'),'loopback'),'2001:db8::2')
  assert.equal(clientIp(request('::ffff:7f00:1','198.51.100.2'),'loopback'),'198.51.100.2')
  for(const header of [undefined,'','192.0.2.1, 198.51.100.2','http://192.0.2.1','192.0.2.1:3000'])
    assert.throws(()=>clientIp(request('127.0.0.1',header),'loopback'),{status:400})
  assert.throws(()=>clientIp(request('127.0.0.1'),'yes'),{status:503})
})
test('同一代理或校园出口的无效请求不能耗尽另一账号登录或改密窗口',async()=>{
  const db=new DatabaseSync(':memory:')
  try{
    db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,department TEXT,role TEXT,enabled INTEGER);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER);`)
    const authentication=createAuthentication(db),password='Known-Password-2026'
    const encoded=await encodePassword(password)
    for(const id of ['attacker','teacher']){
      db.prepare('INSERT INTO users VALUES(?,?,?,?,1)').run(id,id,'学院','counselor')
      db.prepare('INSERT INTO credentials VALUES(?,?,0)').run(id,encoded)
    }
    const peer='127.0.0.1'
    for(let i=0;i<3000;i++)await assert.rejects(authentication.login({},peer),{status:401})
    for(let i=0;i<10;i++)await assert.rejects(authentication.login({id:'attacker',password:'Wrong-Password-2026'},peer),{status:401})
    await assert.rejects(authentication.login({id:'attacker',password},peer),{status:429})
    const valid=await authentication.login({id:'teacher',password},peer)
    assert.equal(valid.user.id,'teacher')
    for(let i=0;i<10;i++)await assert.rejects(authentication.changePassword({id:'attacker'},{oldPassword:'bad',newPassword:'Another-Password-2026'},peer,()=>{}),{status:403})
    await assert.rejects(authentication.changePassword({id:'attacker'},{oldPassword:password,newPassword:'Another-Password-2026'},peer,()=>{}),{status:429})
    const changed=await authentication.changePassword({id:'teacher'},{oldPassword:password,newPassword:'Teacher-New-Password-2026'},peer,()=>{})
    assert.equal(changed.user.id,'teacher')
  }finally{db.close()}
})
