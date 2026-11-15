const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
function screen(api){
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/stastic/static.js'),'utf8'),{require:()=>api,Page:value=>{page=value},Date,console})
  page.data=JSON.parse(JSON.stringify(page.data))
  page.setData=patch=>Object.assign(page.data,patch)
  return page
}
const report=(rows,extra={})=>({year:2025,rows,total:rows.length,hasMore:false,nextOffset:null,totals:{recordCount:7,attendedCount:3,totalHours:5.5},...extra})
test('统一统计仅身份确认后的管理员请求数据，普通用户不显示统计',async()=>{
  for(const role of ['admin','counselor']){
    const calls=[]
    const page=screen({guard:()=>true,time:()=>'',error(){},request:async url=>{calls.push(url);return url==='/api/me'?{role}:report([])}})
    await page.load()
    assert.equal(page.data.authorized,role==='admin')
    assert.equal(calls.length,role==='admin'?2:1)
    assert.equal(page.data.loading,false)
  }
})
test('切换维度与年度后，旧响应不覆盖新条件或恢复旧导出',async()=>{
  const pending=[]
  const page=screen({guard:()=>true,time:()=>'',error(){},request:url=>url==='/api/me'?Promise.resolve({role:'admin'}):new Promise(resolve=>pending.push({url,resolve}))})
  const initial=page.load();await new Promise(setImmediate)
  pending[0].resolve(report([{key:'platform:1',name:'活动'}]));await initial
  const old=page.changeDimension({currentTarget:{dataset:{dimension:'counselor'}}})
  const latest=page.changeYear({detail:{value:'25'}})
  pending[2].resolve(report([{key:'c1',name:'新年度'}]));await latest
  pending[1].resolve(report([{key:'old',name:'旧数据'}]));await old
  assert.equal(page.data.year,2025);assert.equal(page.data.rows[0].name,'新年度')
  assert.equal(page.data.canExport,true)
})
test('搜索未应用时禁止导出和加载，不会在回到页面时卡住加载',async()=>{
  let writes=0,reads=0
  const page=screen({guard:()=>true,time:()=>'',error(){},exportExcel:async()=>{writes++},request:async url=>{if(url==='/api/me')return{role:'admin'};reads++;return report([{key:'platform:1'}])}})
  await page.load();assert.equal(reads,1)
  page.inputQuery({detail:{value:'学院A'}})
  await page.exportData();await page.onShow()
  assert.equal(writes,0);assert.equal(reads,1);assert.equal(page.data.loading,false)
  await page.search();await page.exportData()
  assert.equal(reads,2);assert.equal(writes,1)
})
test('下钻和导出采用同一组条件，返回后旧明细响应不能覆盖汇总',async()=>{
  const pending=[],exports=[]
  const key='external:'+JSON.stringify(['共同培训','主办方','2025-02-01'])
  const page=screen({guard:()=>true,time:()=>'',error(){},exportExcel:async url=>exports.push(url),request:url=>url==='/api/me'?Promise.resolve({role:'admin'}):new Promise(resolve=>pending.push({url,resolve}))})
  const initial=page.load();await new Promise(setImmediate)
  pending[0].resolve(report([{key,name:'共同培训',recordCount:2,totalHours:4}]));await initial
  const drill=page.select({currentTarget:{dataset:{key}}})
  assert.match(pending[1].url,/statistics\/records/)
  assert.ok(pending[1].url.includes('key='+encodeURIComponent(key)))
  pending[1].resolve(report([{id:'external:1',name:'老师甲',title:'共同培训'}]));await drill
  await page.exportData()
  assert.ok(exports[0].includes('key='+encodeURIComponent(key)))
  assert.ok(!exports[0].includes('limit='))
  const refresh=page.fetchRows()
  const returning=page.back()
  pending[3].resolve(report([{key:'platform:2',name:'汇总'}]));await returning
  pending[2].resolve(report([{id:'late',name:'不应显示'}]));await refresh
  assert.equal(page.data.selected,null);assert.equal(page.data.rows[0].name,'汇总')
})
test('加载失败禁用旧数据导出，重试成功后恢复，旧页面消失响应被忽略',async()=>{
  let fail=false,exported=0,resolveLate
  const page=screen({guard:()=>true,time:()=>'',error(){},exportExcel:async()=>{exported++},request:async url=>{
    if(url==='/api/me')return{role:'admin'}
    if(fail)throw new Error('断网')
    return report([{key:'platform:1'}])
  }})
  await page.load();fail=true;await page.fetchRows();await page.exportData()
  assert.equal(exported,0);assert.equal(page.data.canExport,false)
  fail=false;await page.load();assert.equal(page.data.canExport,true)
  const late=screen({guard:()=>true,time:()=>'',error(){},request:url=>url==='/api/me'?Promise.resolve({role:'admin'}):new Promise(resolve=>{resolveLate=resolve})})
  const loading=late.load();await new Promise(setImmediate);late.onHide();resolveLate(report([{key:'late'}]));await loading
  assert.equal(late.data.canExport,false);assert.equal(late.data.rows.length,0)
})
test('工作台只保留统一统计入口，审计归入功能区，密码在退出上方',()=>{
  const home=fs.readFileSync(path.join(__dirname,'../pages/index/index.wxml'),'utf8')
  assert.ok(!home.includes('url="/pages/stastic/people/people"'))
  assert.equal((home.match(/url="\/pages\/stastic\/static"/g)||[]).length,1)
  assert.ok(home.includes('数据统计与排名'))
  assert.ok(home.indexOf('url="/pages/audit/audit"')<home.indexOf('class="logout"'))
  const profile=fs.readFileSync(path.join(__dirname,'../pages/profile/profile.wxml'),'utf8')
  assert.ok(profile.indexOf('url="/pages/password/password"')<profile.indexOf('bindtap="logout"'))
})

test('旧统计页面保留链接并进入统一页对应维度',()=>{
  for(const [route,dimension]of [['people','counselor'],['ranking','ranking']]){
    let config,target
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/stastic/'+route+'/'+route+'.js'),'utf8'),{
      Page:value=>{config=value},wx:{redirectTo:options=>{target=options.url}},
    })
    config.onLoad()
    assert.equal(target,'/pages/stastic/static?dimension='+dimension)
  }
})
