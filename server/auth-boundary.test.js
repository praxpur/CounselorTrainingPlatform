process.env.DB_PATH=':memory:'
process.env.NODE_ENV='test'
process.env.ENABLE_DEV_LOGIN='1'
const {test,before,after}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {createAuthentication,encodePassword}=require('./auth')
const {server,db}=require('./server')
const oldPassword='Old-Account-Password-2026',newPassword='New-Account-Password-2026'
let base
before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  base='http://127.0.0.1:'+server.address().port
  db.prepare("INSERT INTO users(id,name,department,role) VALUES('staff','老师','学院','counselor')").run()
  db.prepare('INSERT INTO credentials VALUES(?,?,0)').run('staff',await encodePassword(oldPassword))
})
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()})
async function call(route,method='GET',body,token){
  const response=await fetch(base+route,{method,headers:token?{authorization:'Bearer '+token}:{},...(body?{body:JSON.stringify(body)}:{})})
  return {status:response.status,body:await response.json()}
}
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex')

test('生产环境拒绝同一正式账号曾获取的开发会话，正式签发和退出正确维护标志',async()=>{
  const dev=await call('/api/auth/dev','POST',{id:'staff',name:'老师'})
  assert.equal(dev.status,200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM verified_sessions WHERE token_hash=?').get(tokenHash(dev.body.token)).n,0)
  const original=process.env.NODE_ENV
  process.env.NODE_ENV='production'
  try{
    assert.equal((await call('/api/me','GET',null,dev.body.token)).status,401)
    assert.equal((await call('/api/activities','GET',null,dev.body.token)).status,401)
    const official=await call('/api/auth/login','POST',{id:'staff',password:oldPassword})
    assert.equal(official.status,200)
    assert.equal((await call('/api/me','GET',null,official.body.token)).status,200)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM verified_sessions WHERE token_hash=?').get(tokenHash(official.body.token)).n,1)
    assert.equal((await call('/api/logout','POST',{},official.body.token)).status,200)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM verified_sessions WHERE token_hash=?').get(tokenHash(official.body.token)).n,0)
  }finally{process.env.NODE_ENV=original}
})

async function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'training-auth-boundary-')),filename=path.join(root,'test.db')
  const first=new DatabaseSync(filename)
  first.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=2000;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,department TEXT,role TEXT,enabled INTEGER DEFAULT 1);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER);
    INSERT INTO users VALUES('staff','老师','学院','counselor',1);`)
  const auth=createAuthentication(first),originalHash=await encodePassword(oldPassword),replacement=await encodePassword(newPassword)
  first.prepare('INSERT INTO credentials VALUES(?,?,0)').run('staff',originalHash)
  const second=new DatabaseSync(filename)
  second.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=2000')
  return {db:first,other:second,auth,originalHash,replacement,close(){second.close();first.close();fs.rmSync(root,{recursive:true,force:true})}}
}

test('登录在取得写锁后检查最新密码，期间管理员重置不能继续签发旧密码会话',async()=>{
  const state=await fixture()
  const originalExec=state.db.exec.bind(state.db)
  let reset=false
  state.db.exec=sql=>{
    if(sql==='BEGIN IMMEDIATE'&&!reset){
      reset=true
      // 模拟另一连接在本连接取得写锁前提交新密码。
      state.other.prepare('UPDATE credentials SET password_hash=? WHERE user_id=?').run(state.replacement,'staff')
    }
    return originalExec(sql)
  }
  try{
    await assert.rejects(state.auth.login({id:'staff',password:oldPassword},'127.0.0.1'),{status:401})
    assert.equal(reset,true)
    assert.equal(state.db.prepare('SELECT password_hash FROM credentials').get().password_hash,state.replacement)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0)
  }finally{state.db.exec=originalExec;state.close()}
})

test('改密在写锁内复核会话与凭据，不覆盖刚提交的管理员重置',async()=>{
  const state=await fixture()
  const session=await state.auth.login({id:'staff',password:oldPassword},'127.0.0.1')
  const originalExec=state.db.exec.bind(state.db)
  let reset=false,checked=false
  state.db.exec=sql=>{
    if(sql==='BEGIN IMMEDIATE'&&!reset){
      reset=true
      state.other.prepare('UPDATE credentials SET password_hash=?,must_change=1 WHERE user_id=?').run(state.replacement,'staff')
      state.other.prepare('DELETE FROM sessions WHERE user_id=?').run('staff')
    }
    return originalExec(sql)
  }
  try{
    await assert.rejects(state.auth.changePassword({id:'staff'},{oldPassword,newPassword:'User-Changed-Password-2026'},'127.0.0.1',()=>{
      checked=true
      assert.throws(()=>originalExec('BEGIN IMMEDIATE'),/transaction/)
      if(!state.db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(tokenHash(session.token)))
        throw Object.assign(new Error('已撤销'),{status:401})
    }),{status:401})
    assert.equal(checked,true)
    assert.equal(state.db.prepare('SELECT password_hash FROM credentials').get().password_hash,state.replacement)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM verified_sessions').get().n,0)
  }finally{state.db.exec=originalExec;state.close()}
})

test('正式会话标志落库失败会回滚签发与过期清理',async()=>{
  const state=await fixture()
  try{
    const expired='a'.repeat(64)
    state.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(expired,'staff',Date.now()-1000)
    state.db.prepare('INSERT INTO verified_sessions VALUES(?)').run(expired)
    state.db.exec("CREATE TRIGGER reject_verified BEFORE INSERT ON verified_sessions BEGIN SELECT RAISE(ABORT,'marker unavailable');END")
    await assert.rejects(state.auth.login({id:'staff',password:oldPassword},'127.0.0.1'),/marker unavailable/)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM verified_sessions').get().n,1)
  }finally{state.close()}
})

test('统一审核的待审数与可见列表一致，不计算孤立旧经历',()=>{
  const legacy=new DatabaseSync(':memory:')
  try{
    legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,department TEXT);
      INSERT INTO users VALUES('staff','老师','学院');
      CREATE TABLE experiences(id INTEGER PRIMARY KEY,user_id TEXT,activity_id INTEGER,title TEXT,description TEXT,status TEXT,credit_hours REAL,review_note TEXT,created_at INTEGER);
      INSERT INTO experiences VALUES(1,'staff',NULL,'旧经历','未关联活动','pending',0,'',1);`)
    const evidence=require('./evidence').createEvidence(legacy)
    const result=evidence.combinedReviews(new URL('http://localhost/api/admin/reviews?status=pending&limit=20'))
    assert.equal(result.rows.length,0)
    assert.equal(result.pendingCount,0)
  }finally{legacy.close()}
})
