// 必须由负载运行器创建独立目录与标记；直接运行不得触碰默认/正式数据库。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const http=require('node:http'),crypto=require('node:crypto')
function fixture(){
  const directory=path.resolve(process.env.LOAD_RUN_DIR||'.'),runId=process.env.LOAD_RUN_ID||''
  if(!process.send||!/^counselor-load-/.test(path.basename(directory))||path.dirname(directory).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!/^[a-f0-9]{32}$/.test(runId))throw new Error('负载夹具只允许由运行器启动')
  if(fs.lstatSync(directory).isSymbolicLink())throw new Error('负载目录不能是符号链接')
  const marker=JSON.parse(fs.readFileSync(path.join(directory,'fixture.json'),'utf8'))
  const dbPath=process.env.DB_PATH
  if(marker.runId!==runId||!Number.isInteger(marker.users)||marker.users<1||marker.users>1000||!Number.isInteger(marker.capacity)||marker.capacity<0)throw new Error('负载标记无效')
  if(dbPath!==':memory:'&&(path.resolve(dbPath||'.')!==path.join(directory,'load.db')||fs.existsSync(dbPath)))throw new Error('必须使用尚不存在的独立负载数据库')
  const probe=process.argv.includes('--probe')
  const {server,db}=probe?{server:http.createServer((req,res)=>res.end('ok'))}:require('./server')
  const tokens=[],now=Date.now()
  if(db){
    db.exec('BEGIN IMMEDIATE')
    try{
      const addUser=db.prepare("INSERT INTO users(id,name,department,role) VALUES(?,?,?,'counselor')"),addSession=db.prepare('INSERT INTO sessions VALUES(?,?,?)')
      for(let i=0;i<marker.users;i++){
        const id='load-'+i,token=crypto.randomBytes(32).toString('hex')
        addUser.run(id,id,'独立负载验证');addSession.run(crypto.createHash('sha256').update(token).digest('hex'),id,now+3600000);tokens.push(token)
      }
      db.prepare("INSERT INTO activities(id,title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES(1,'并发验证','','',?,?,?,2,?)").run(now+3600000,now+7200000,marker.capacity,now)
      db.exec('COMMIT')
    }catch(error){db.exec('ROLLBACK');throw error}
  }else tokens.push(...Array.from({length:marker.users},()=>null))
  let accepted=0,requests=0,stopping=false
  server.on('connection',()=>accepted++);server.on('request',()=>requests++)
  function metrics(){
    const result={accepted,requests}
    if(db){
      result.historicalCount=db.prepare('SELECT COUNT(*) n FROM registrations').get().n
      result.activeCount=db.prepare('SELECT COUNT(*) n FROM registrations WHERE cancelled_at IS NULL').get().n
      result.withdrawnCount=db.prepare('SELECT COUNT(*) n FROM registrations WHERE cancelled_at IS NOT NULL').get().n
      result.duplicates=db.prepare('SELECT activity_id,user_id FROM registrations GROUP BY activity_id,user_id HAVING COUNT(*)>1').all().length
      result.integrity=db.prepare('PRAGMA integrity_check').all()
      result.foreignKeys=db.prepare('PRAGMA foreign_key_check').all()
      if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'").get())result.notificationRows=db.prepare('SELECT COUNT(*) n FROM notifications').get().n
    }
    return result
  }
  server.listen({port:0,host:'127.0.0.1',backlog:Number(process.env.LISTEN_BACKLOG||2048)},()=>process.send({type:'ready',port:server.address().port,tokens,
    storageMode:probe?'none':dbPath===':memory:'?'memory':'temporary-disk',journalMode:db?.prepare('PRAGMA journal_mode').get().journal_mode,synchronous:db?.prepare('PRAGMA synchronous').get().synchronous}))
  process.on('message',message=>{
    if(message.type==='inspect')process.send({type:'snapshot',id:message.id,result:metrics()})
    if(message.type==='stop'&&!stopping){
      stopping=true
      const result=metrics()
      server.close(()=>{db?.close();process.send({type:'stopped',id:message.id,result},()=>process.disconnect())})
      server.closeAllConnections()
    }
  })
  process.on('disconnect',()=>{if(!stopping){server.closeAllConnections();server.close(()=>{db?.close()})}})
}
try{fixture()}catch(error){console.error(error.message);process.exitCode=1}
