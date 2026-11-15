const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')

function messagePage(api,overrides={}){
  let config
  const navigation=[],errors=[]
  const wx={navigateTo:value=>navigation.push(value.url),switchTab:value=>navigation.push('tab:'+value.url),showToast(){},...overrides}
  const client={guard:()=>true,time:()=>'',error:error=>errors.push(error.message),...api}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/notifications/notifications.js'),'utf8'),{
    require:specifier=>specifier.endsWith('/pagination')?require('../utils/pagination'):client,
    Page:value=>{config=value},wx,
  })
  config.data=JSON.parse(JSON.stringify(config.data))
  config.setData=function(value){Object.assign(this.data,value)}
  return {page:config,navigation,errors}
}

test('消息页加载自己的20条分页，点击标记已读后才打开经过核验的目标',async()=>{
  const urls=[]
  let finishRead,writes=0
  const {page,navigation}=messagePage({request:(url,method)=>{
    urls.push(url)
    if(method==='POST'){writes++;return new Promise(resolve=>{finishRead=resolve})}
    return Promise.resolve({rows:[{id:1,title:'培训审核通过',body:'认定1.5学时',createdAt:1,readAt:null}],total:1,hasMore:false,nextOffset:null,unreadCount:2})
  }})
  await page.load()
  assert.match(urls[0],/limit=20/)
  const task=page.open({currentTarget:{dataset:{id:1}}})
  await page.open({currentTarget:{dataset:{id:1}}})
  assert.equal(writes,1)
  assert.equal(navigation.length,0)
  finishRead({readAt:123,unreadCount:1,target:{url:'/pages/self-training/self-training?id=10',tab:false}})
  await task
  assert.equal(page.data.rows[0].readAt,123)
  assert.equal(page.data.unreadCount,1)
  assert.deepEqual(navigation,['/pages/self-training/self-training?id=10'])
})

test('未读筛选和全部已读重新查询当前账号，不能保留被读掉的结果',async()=>{
  let cleared=false
  const urls=[]
  const {page}=messagePage({request:async(url,method)=>{
    urls.push(url)
    if(method==='POST'){assert.equal(url,'/api/notifications/read-all');cleared=true;return {updated:1,readAt:200,unreadCount:0}}
    return {rows:cleared?[]:[{id:3,title:'活动发布',createdAt:1,readAt:null}],total:cleared?0:1,hasMore:false,unreadCount:cleared?0:1}
  }})
  await page.toggleUnread()
  assert.match(urls[0],/unread=1/)
  await page.readAll()
  assert.equal(page.data.unreadCount,0)
  assert.equal(page.data.rows.length,0)
  assert.match(urls.at(-1),/unread=1/)
})

test('通知目标只允许固定业务页面，记录使用 switchTab，失效目标不乱跳',async()=>{
  for(const target of [null,{url:'/pages/users/users',tab:false},{url:'/pages/record/record',tab:true}]){
    const {page,navigation,errors}=messagePage({request:async(_url,method)=>method==='POST'?{readAt:100,unreadCount:0,target}:{rows:[{id:1,createdAt:1,readAt:null}],total:1,hasMore:false,unreadCount:1}})
    await page.load();await page.open({currentTarget:{dataset:{id:1}}})
    if(target?.url==='/pages/record/record')assert.deepEqual(navigation,['tab:/pages/record/record'])
    else assert.equal(navigation.length,0)
    if(target?.url==='/pages/users/users')assert.equal(errors.length,1)
  }
})

test('加载更多与上一页保留通知快照，手动刷新重新取最新快照',async()=>{
  const urls=[]
  const {page}=messagePage({request:async url=>{
    urls.push(url)
    return {rows:[{id:100-urls.length,createdAt:1}],total:40,hasMore:true,nextOffset:20,snapshot:urls.length===1?50:60,unreadCount:2,hasNewer:urls.length>1}
  }})
  await page.load();await page.more()
  assert.ok(!urls[0].includes('snapshot='));assert.match(urls[1],/snapshot=50/)
  assert.equal(page.data.hasNewer,true)
  await page.load({type:'tap'})
  assert.ok(!urls[2].includes('snapshot='))
})

function entryComponent(api){
  let config,nextTimer=0
  const timers=new Map(),errors=[]
  const client={guard:()=>true,error:error=>errors.push(error.message),...api}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/notification-entry/notification-entry.js'),'utf8'),{
    require:()=>client,Component:value=>{config=value},
    setInterval:callback=>{const key=++nextTimer;timers.set(key,callback);return key},clearInterval:key=>timers.delete(key),
  })
  const instance={data:JSON.parse(JSON.stringify(config.data)),setData(value){Object.assign(this.data,value)}}
  for(const [key,method] of Object.entries(config.methods))instance[key]=method.bind(instance)
  return {config,instance,timers,errors}
}

test('消息入口只保留一个轮询，隐藏/卸载清理计时器并丢弃旧响应',async()=>{
  const pending=[]
  const {config,instance,timers}=entryComponent({request:()=>new Promise(resolve=>pending.push(resolve))})
  config.lifetimes.attached.call(instance)
  config.pageLifetimes.show.call(instance)
  assert.equal(pending.length,1)
  assert.equal(timers.size,1)
  config.pageLifetimes.hide.call(instance)
  assert.equal(timers.size,0)
  config.pageLifetimes.show.call(instance)
  assert.equal(pending.length,2)
  pending[0]({unreadCount:99})
  await new Promise(setImmediate)
  assert.equal(instance.data.unreadCount,0)
  pending[1]({unreadCount:2})
  await new Promise(setImmediate)
  assert.equal(instance.data.unreadCount,2)
  config.lifetimes.detached.call(instance)
  assert.equal(timers.size,0)
})

test('消息入口网络失败不重复弹窗，认证失败交给统一登录处理',async()=>{
  let auth=false
  const {instance,errors}=entryComponent({request:async()=>{
    throw auth?Object.assign(new Error('请登录'),{statusCode:401}):new Error('网络不可用')
  }})
  instance.active=true
  await instance.refresh()
  assert.equal(instance.data.available,false);assert.equal(errors.length,0)
  auth=true
  await instance.refresh()
  assert.deepEqual(errors,['请登录'])
})
