const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const pagination=require('../utils/pagination')
function screen(name,api,wx={}){
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages',name),'utf8'),{
    require:name=>name.endsWith('pagination')?pagination:api,Page:value=>{page=value},wx,Date,console,
  })
  page.data=JSON.parse(JSON.stringify(page.data))
  page.setData=patch=>Object.assign(page.data,patch)
  return page
}
const event=(id,status)=>({currentTarget:{dataset:{id,status}}})
const list=rows=>({rows,total:rows.length,hasMore:false,nextOffset:null})
test('A6 review drafts stay visible across refresh, clear only reviewed or revised records',async()=>{
  let rows=[{id:'experience:1',reviewId:1,status:'pending',description:'first'},{id:'experience:2',reviewId:2,status:'pending'}]
  let confirm
  const writes=[]
  const page=screen('reviews/reviews.js',{guard:()=>true,error(){},request:async(url,method,body)=>{
    if(method==='POST'){writes.push(body);return{}}
    return list(rows)
  }},{showModal:value=>{confirm=value.success},showToast(){}})
  await page.load()
  page.input({...event('experience:1'),detail:{value:'draft reason'}})
  page.input({...event('experience:2'),detail:{value:'other reason'}})
  page.inputHours({...event('experience:2'),detail:{value:'3'}})
  page.review(event('experience:2','approved'));await confirm({confirm:true})
  assert.equal(page.data.notes['experience:1'],'draft reason')
  assert.equal(page.data.notes['experience:2'],undefined)
  assert.equal(page.data.hours['experience:2'],undefined)
  assert.equal(writes[0].note,'other reason')
  const wxml=fs.readFileSync(path.join(__dirname,'../pages/reviews/reviews.wxml'),'utf8')
  assert.ok(wxml.includes('value="{{notes[item.id] || \'\'}}"'))
  rows=[{...rows[0],description:'resubmitted'},rows[1]]
  await page.load()
  assert.equal(page.data.notes['experience:1'],undefined)
})
test('A7 closing another attendance phase preserves displayed QR; own close and unload delete it',async()=>{
  const deleted=[]
  const page=screen('attendance-manage/attendance-manage.js',{request:async()=>({}),error(){}},{getFileSystemManager:()=>({unlink:({filePath})=>deleted.push(filePath)})})
  page.id='1';page.load=async()=>{}
  page.qrPath='out.png';page.setData({qrPhase:'out',qrImage:'out.png',qrExpires:'later'})
  await page.close({currentTarget:{dataset:{phase:'in'}}})
  assert.equal(deleted.length,0);assert.equal(page.data.qrImage,'out.png')
  await page.close({currentTarget:{dataset:{phase:'out'}}})
  assert.deepEqual(deleted,['out.png']);assert.equal(page.data.qrImage,'');assert.equal(page.data.qrPhase,'')
  page.qrPath='new.png';page.onUnload();assert.deepEqual(deleted,['out.png','new.png'])
})
test('A8 unsubmitted user search cannot mix pagination and ignores in-flight responses',async()=>{
  const pending=[]
  const page=screen('users/users.js',{guard:()=>true,error(){},request:url=>new Promise(resolve=>pending.push({url,resolve}))})
  const initial=page.load();pending[0].resolve({rows:[{id:'A'}],hasMore:true,nextOffset:20,total:40});await initial
  const old=page.more()
  page.searchInput({detail:{value:' B '}})
  await page.more();await page.previous()
  assert.equal(pending.length,2)
  pending[1].resolve({rows:[{id:'late-A'}],hasMore:false,total:40});await old
  assert.equal(page.data.users.length,1)
  const search=page.search()
  assert.match(pending[2].url,/q=B&limit=20&offset=0$/)
  pending[2].resolve({rows:[{id:'B'}],hasMore:true,nextOffset:20,total:30});await search
  assert.equal(page.data.appliedQuery,'B');assert.equal(page.data.users[0].id,'B')
  const more=page.more();assert.match(pending[3].url,/q=B&limit=20&offset=20$/)
  pending[3].resolve(list([{id:'B2'}]));await more
  assert.equal(page.data.users.length,2)
})
test('A9 export settling after resume reloads data for success and failure',async()=>{
  for(const fail of [false,true]){
    let settle,reads=0
    const page=screen('stastic/static.js',{guard:()=>true,time:()=>'',error(){},request:async url=>{
      if(url==='/api/me')return{role:'admin'}
      reads++;return list([{key:String(reads)}])
    },exportExcel:()=>new Promise((resolve,reject)=>{settle=()=>fail?reject(new Error('cancelled')):resolve()})})
    await page.onShow();const exporting=page.exportData()
    page.onHide();await page.onShow()
    assert.equal(reads,1);assert.equal(page.data.canExport,false)
    settle();await exporting
    assert.equal(reads,2);assert.equal(page.data.canExport,true);assert.equal(page.data.exporting,false)
  }
})
test('A9 background export completion waits for return and reload failure exposes retry',async()=>{
  let settle,reads=0,fail=false
  const page=screen('stastic/static.js',{guard:()=>true,time:()=>'',error(){},request:async url=>{
    if(url==='/api/me')return{role:'admin'}
    reads++;if(fail)throw new Error('offline');return list([])
  },exportExcel:()=>new Promise(resolve=>{settle=resolve})})
  await page.onShow();const exporting=page.exportData();page.onHide();settle();await exporting
  assert.equal(reads,1)
  fail=true;await page.onShow()
  assert.equal(page.data.errorMessage,'offline');assert.equal(page.data.loading,false)
  fail=false;await page.load();assert.equal(page.data.canExport,true)
})
