// 隔离服务进程与临时磁盘 WAL；所有请求零重试，绝不读取实际 training.db。
const http=require('node:http'),fs=require('node:fs/promises'),syncFs=require('node:fs')
const path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const {fork}=require('node:child_process'),{performance}=require('node:perf_hooks')
function options(argv){
  const result={users:500,cold:false,registerFirst:false,unlimited:false,memory:false,probe:false,sameProcess:false,skipNotifications:false,output:null}
  const flags={'--cold':'cold','--register-first':'registerFirst','--unlimited':'unlimited','--memory':'memory','--probe':'probe','--same-process':'sameProcess','--skip-notifications':'skipNotifications'}
  for(let i=0;i<argv.length;i++){
    const arg=argv[i]
    if(flags[arg])result[flags[arg]]=true
    else if(arg==='--users')result.users=Number(argv[++i])
    else if(arg==='--output'){result.output=argv[++i];if(!result.output||result.output.startsWith('--'))throw new Error('--output 需要输出文件路径')}
    else throw new Error('未知负载参数：'+arg)
  }
  if(!Number.isInteger(result.users)||result.users<1||result.users>1000)throw new Error('用户数须为 1—1000（默认500）')
  if(result.sameProcess&&!result.probe)throw new Error('同进程模式仅允许纯 HTTP 对照')
  return result
}
async function main(argv=process.argv.slice(2),{forkFixture=fork,shutdownTimeout=5000}={}){
  const config=options(argv),capacity=config.unlimited?config.users:Math.min(125,config.users),runId=crypto.randomBytes(16).toString('hex')
  let directory,child,localServer,port,tokens=[],readyTimer,totalTimer,exited,exitInfo,result,failure,output,rejectStartup,exitObserved=false
  let cleanup={removed:false,reason:"not-created"}
  const phases=[],pending=new Map(),sockets=[]
  const agent=new http.Agent({keepAlive:true,maxSockets:config.users,maxTotalSockets:config.users,maxFreeSockets:config.users})
  const log=value=>{const line=JSON.stringify(value);console.log(line);if(output!==undefined)syncFs.writeSync(output,line+'\n')}
  async function ipc(type){
    if(localServer)return {accepted:localServer.accepted,requests:localServer.requests}
    if(!child?.connected)throw new Error('负载夹具已断开')
    const id=crypto.randomUUID()
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('夹具响应超时'))},shutdownTimeout)
      pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
      child.send({type,id},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error)}})
    })
  }
  const interrupt=signal=>{
    failure=failure||new Error('负载验证中断：'+signal)
    rejectStartup?.(failure)
    agent.destroy();for(const socket of sockets)socket.destroy()
    child?.kill();localServer?.closeAllConnections()
  }
  const onInterrupt=()=>interrupt('SIGINT'),onTerminate=()=>interrupt('SIGTERM')
  process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate)
  async function waitForExit(milliseconds){
    if(exitObserved)return true
    let timer
    try{return await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds)})])}
    finally{clearTimeout(timer)}
  }
  async function phase(name,route,method='GET',expected={},validate){
    if(failure)throw failure
    const responses=await Promise.all(tokens.map(token=>new Promise(resolve=>{
      const start=performance.now();let done=false,timer
      const finish=(status,valid=true)=>{if(done)return;done=true;clearTimeout(timer);resolve({status,valid,reused:request.reusedSocket===true,ms:performance.now()-start})}
      const request=http.request({host:'127.0.0.1',port,path:route,method,agent,headers:token?{authorization:'Bearer '+token}:{}},response=>{
        const chunks=[];let bytes=0
        response.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)request.destroy(Object.assign(new Error('body limit'),{code:'BODY_TOO_LARGE'}));else chunks.push(chunk)})
        response.on('aborted',()=>finish('ABORTED',false));response.on('error',error=>finish(error.code||'RESPONSE_ERROR',false))
        response.on('end',()=>{
          let valid=true
          try{if(validate&&response.statusCode===200)valid=validate(Buffer.concat(chunks).toString('utf8'))===true}catch{valid=false}
          finish(response.statusCode,valid)
        })
      })
      timer=setTimeout(()=>request.destroy(Object.assign(new Error('deadline'),{code:'DEADLINE'})),15000)
      request.on('error',error=>finish(error.code||'NETWORK_ERROR',false));request.end()
    })))
    const statuses={},timings=responses.map(row=>row.ms).sort((a,b)=>a-b)
    for(const row of responses)statuses[row.status]=(statuses[row.status]||0)+1
    const quantile=q=>Math.round(timings[Math.max(0,Math.ceil(timings.length*q)-1)])
    const reusedConnections=responses.filter(row=>row.reused).length
    const connectionValid=config.cold||phases.length>0||reusedConnections===config.users
    const passed=connectionValid&&Object.entries(expected).every(([status,count])=>(statuses[status]||0)===count)&&responses.every(row=>row.valid)&&Object.keys(statuses).every(status=>Object.hasOwn(expected,status))
    const metric={phase:name,concurrentUsers:config.users,reusedConnections,statuses,httpResponseRate:responses.filter(row=>typeof row.status==='number').length/config.users,validBodyRate:responses.filter(row=>row.valid).length/config.users,p50Ms:quantile(.5),p95Ms:quantile(.95),p99Ms:quantile(.99),maxMs:quantile(1),passed}
    phases.push(metric);log(metric)
    if(!passed)throw new Error(name+' 未达到预期，零重试')
  }
  try{
    if(config.output){await fs.mkdir(path.dirname(path.resolve(config.output)),{recursive:true});output=syncFs.openSync(config.output,'wx')}
    if(failure)throw failure
    if(config.sameProcess){
      localServer=http.createServer((req,res)=>res.end('ok'));localServer.accepted=0;localServer.requests=0
      localServer.on('connection',()=>localServer.accepted++);localServer.on('request',()=>localServer.requests++)
      await new Promise((resolve,reject)=>{localServer.once('error',reject);localServer.listen({host:'127.0.0.1',port:0,backlog:Number(process.env.LISTEN_BACKLOG||2048)},resolve)})
      port=localServer.address().port;tokens=Array.from({length:config.users},()=>null)
    }else{
      directory=await fs.mkdtemp(path.join(os.tmpdir(),'counselor-load-'));directory=await fs.realpath(directory)
      cleanup={removed:false,retainedDirectory:directory}
      await fs.writeFile(path.join(directory,'fixture.json'),JSON.stringify({runId,users:config.users,capacity:config.unlimited?0:capacity}))
      if(failure)throw failure
      let resolveExit
      exited=new Promise(resolve=>{resolveExit=resolve})
      await new Promise((resolve,reject)=>{
        rejectStartup=reject
        child=forkFixture(path.join(__dirname,'load-fixture.js'),config.probe?['--probe']:[],{env:{...process.env,NODE_ENV:'test',ENABLE_DEV_LOGIN:'0',LOAD_RUN_DIR:directory,LOAD_RUN_ID:runId,DB_PATH:config.memory?':memory:':path.join(directory,'load.db')},stdio:['ignore','inherit','inherit','ipc']})
        readyTimer=setTimeout(()=>{child.kill();reject(new Error('负载服务启动超时'))},20000)
        child.on('error',error=>{failure=failure||error;if(!child.pid){exitInfo={spawnFailed:true,error:error.message};exitObserved=true;resolveExit()}else if(!port)child.kill();reject(error)})
        child.once('exit',(code,signal)=>{
          exitInfo={code,signal};exitObserved=true;resolveExit()
          for(const waiting of pending.values())waiting.reject(new Error('负载服务已退出'))
          pending.clear();if(!port)reject(new Error('负载服务启动失败'))
        })
        child.on('message',message=>{
          if(message.type==='ready'){
            if(!Number.isInteger(message.port)||!Array.isArray(message.tokens)||message.tokens.length!==config.users)return reject(new Error('夹具初始化响应无效'))
            port=message.port;tokens=message.tokens;clearTimeout(readyTimer)
            log({type:'runtime',node:process.version,uv:process.versions.uv,os:os.release(),storageMode:message.storageMode,journalMode:message.journalMode,synchronous:message.synchronous,users:config.users})
            resolve()
          }else if(pending.has(message.id)){const waiting=pending.get(message.id);pending.delete(message.id);waiting.resolve(message.result)}
        })
      })
    }
    totalTimer=setTimeout(()=>interrupt('TIMEOUT'),120000)
    if(!config.cold){
      await Promise.all(Array.from({length:config.users},()=>new Promise((resolve,reject)=>{
        const request=http.get({host:'127.0.0.1',port,path:'/health',agent},response=>{
          response.resume()
          response.once('end',()=>response.statusCode===200?resolve():reject(new Error('预连接健康检查失败')))
          response.once('error',reject)
        })
        const timer=setTimeout(()=>request.destroy(new Error('预连接超时')),15000)
        request.once('close',()=>clearTimeout(timer));request.once('error',reject)
      })))
      await new Promise(setImmediate)
      const pooledSockets=Object.values(agent.freeSockets).reduce((sum,list)=>sum+list.length,0)
      if(pooledSockets!==config.users)throw new Error('HTTP预热未保留足够的可复用连接')
      log({type:'preconnection',warmupRequests:config.users,pooledSockets})
    }
    log({type:'scenario',mode:config.probe?'bare-http':'business',connectionMode:config.cold?'cold-burst':'preconnected',sameProcess:config.sameProcess,registerFirst:config.registerFirst,capacity:config.probe?null:config.unlimited?'unlimited':capacity})
    if(config.probe){await phase('bare-http','/','GET',{200:config.users},text=>text==='ok')}
    else{
      const listing=count=>text=>{const body=JSON.parse(text);return body.total===1&&body.rows.length===1&&body.rows[0].registeredCount===count}
      const register=(name='registration')=>phase(name,'/api/activities/1/register','POST',{200:capacity,...(capacity<config.users?{409:config.users-capacity}:{})},text=>JSON.parse(text).registered===true)
      if(config.registerFirst){await register();await phase('activity-list','/api/activities?limit=20&offset=0','GET',{200:config.users},listing(capacity))}
      else{await phase('activity-list','/api/activities?limit=20&offset=0','GET',{200:config.users},listing(0));await register()}
      await phase('duplicate-registration','/api/activities/1/register','POST',{409:config.users})
      await phase('personal-annual','/api/my/annual?limit=20&offset=0','GET',{200:config.users},text=>{const body=JSON.parse(text);return body.totalHours===0&&body.months.length===12&&Array.isArray(body.records)})
      if(!config.skipNotifications)await phase('notification-count','/api/notifications/unread-count','GET',{200:config.users},text=>Number.isInteger(JSON.parse(text).unreadCount)&&JSON.parse(text).unreadCount>=1)
      await phase('withdrawal','/api/activities/1/register','DELETE',{200:capacity,...(capacity<config.users?{409:config.users-capacity}:{})},text=>JSON.parse(text).registered===false)
      const empty=await ipc('inspect');if(empty.activeCount!==0)throw new Error('取消报名未完全释放名额')
      await phase('released-capacity','/api/activities?limit=20&offset=0','GET',{200:config.users},listing(0))
      await register('reregistration')
      await phase('duplicate-after-reregister','/api/activities/1/register','POST',{409:config.users})
      await phase('final-activity-list','/api/activities?limit=20&offset=0','GET',{200:config.users},listing(capacity))
      result=await ipc('inspect')
      if(result.activeCount!==capacity||result.duplicates!==0||result.foreignKeys.length||result.integrity[0]?.integrity_check!=='ok')throw new Error('数据库一致性检查失败')
      if(!config.skipNotifications&&result.notificationRows!==config.users+3*capacity)throw new Error('通知数量不符合完整报名循环')
    }
  }catch(error){failure=failure||error}
  finally{
    clearTimeout(readyTimer);clearTimeout(totalTimer);agent.destroy();for(const socket of sockets)socket.destroy()
    try{
      if(localServer){result={accepted:localServer.accepted,requests:localServer.requests};localServer.closeAllConnections();await new Promise(resolve=>localServer.close(resolve))}
      if(child){
        try{if(child.connected&&!exitObserved){const stopped=await ipc('stop');if(!result)result=stopped}}
        catch(error){failure=failure||error;child.kill()}
        if(exited&&!await waitForExit(shutdownTimeout)){
          child.kill()
          if(!await waitForExit(shutdownTimeout)){
            failure=failure||new Error('无法确认负载子进程退出，临时目录保留以供检查')
            if(child.connected)child.disconnect()
            child.unref();child.channel?.unref()
          }
        }
        if(exitObserved&&(!exitInfo||exitInfo.code!==0||exitInfo.signal))failure=failure||new Error('负载子进程非正常退出')
      }
      if(directory&&(!child||exitObserved)){
        const marker=JSON.parse(await fs.readFile(path.join(directory,'fixture.json'),'utf8'))
        if(marker.runId!==runId||path.resolve(await fs.realpath(directory)).toLowerCase()!==path.resolve(directory).toLowerCase())throw new Error('拒绝清理异常负载路径')
        await fs.rm(directory,{recursive:true,force:true});cleanup={removed:true}
      }
    }catch(error){failure=failure||error}
    log({type:'summary',passed:!failure,cleanup,childExit:exitInfo,users:config.users,phaseCount:phases.length,zeroRetries:true,result,...(failure?{error:failure.message}:{})})
    if(output!==undefined)syncFs.closeSync(output)
    process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate)
  }
  if(failure)throw failure
  return {passed:true,result,phases}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1})
module.exports={main,options}
