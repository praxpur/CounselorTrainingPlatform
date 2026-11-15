const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('旧管理和统计入口保持注册并跳转到当前页面，失败时有回退',()=>{
  const routes=JSON.parse(fs.readFileSync(path.join(__dirname,'../app.json'),'utf8')).pages
  for(const [route,target] of [['pages/admin/admin','/pages/activity-manage/activity-manage'],['pages/people/people','/pages/stastic/people/people'],['pages/ranking/ranking','/pages/stastic/ranking/ranking']]){
    assert.ok(routes.includes(route))
    let redirected,relaunched
    const {page:entry}=page(route+'.js',{}, {
      redirectTo:options=>{redirected=options.url;options.fail()},reLaunch:options=>{relaunched=options.url},
    })
    entry.onLoad()
    assert.equal(redirected,target);assert.equal(relaunched,target)
  }
})

test('注册页面、字面量品牌资源完整，运维目录排除出小程序包',()=>{
  const root=path.join(__dirname,'..'),config=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'))
  for(const route of config.pages)for(const ext of ['.js','.json','.wxml','.wxss'])assert.ok(fs.existsSync(path.join(root,route+ext)),route+ext)
  for(const folder of ['pages','components']){
    const inspect=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name)
      if(entry.isDirectory())inspect(file)
      else if(file.endsWith('.wxml'))for(const match of fs.readFileSync(file,'utf8').matchAll(/\bsrc="(\/assets\/[^"{}]+)"/g))assert.ok(fs.existsSync(path.join(root,match[1])),file+': '+match[1])
    }}
    inspect(path.join(root,folder))
  }
  const packed=JSON.parse(fs.readFileSync(path.join(root,'project.config.json'),'utf8')).packOptions.ignore
  for(const value of ['server','deploy','docs','tmp'])assert.ok(packed.some(item=>item.type==='folder'&&item.value===value),value)
})

test('活动分页追加不重复，切换年份后旧响应不能覆盖新列表', async () => {
  const pending=[]
  const {page:list}=page('pages/course/list.js',{
    guard:()=>true,error(){},format:value=>value,
    request:url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject})),
  })
  const old=list.load()
  list.changeYear({detail:{value:'26'}})
  pending[1].resolve({rows:[{id:1},{id:2}],total:3,hasMore:true,nextOffset:2})
  await new Promise(setImmediate)
  pending[0].resolve({rows:[{id:99}],total:1,hasMore:false})
  await old
  assert.equal(list.data.activities[0].id,1)
  const next=list.more()
  await list.more()
  assert.equal(pending.length,3)
  assert.match(pending[2].url,/offset=2/)
  pending[2].reject(new Error('临时断网'))
  await next
  assert.equal(list.data.activities.length,2)
  const retry=list.more()
  pending[3].resolve({rows:[{id:3}],total:3,hasMore:false,nextOffset:null})
  await retry
  assert.equal(list.data.activities.length,3)
  assert.equal(new Set(list.data.activities.map(value=>value.id)).size,3)
})

test('年度明细加载更多保持完整年度汇总，不能按已加载页重算学时', async () => {
  let calls=0
  const {page:annual}=page('pages/my-hours/my-hours.js',{
    guard:()=>true,error(){},time:()=>'',
    request:async()=>({year:2025,total:132,activityCount:132,totalHours:130.55,months:[{month:1,hours:130.55}],
      records:[{id:++calls}],hasMore:calls===1,nextOffset:calls===1?1:null}),
  })
  await annual.load();await annual.more()
  assert.equal(annual.data.records.length,2)
  assert.equal(annual.data.report.activityCount,132)
  assert.equal(annual.data.report.totalHours,130.55)
})

test('长经历列表限制页面保留量，切换窗口后仍可返回上一页', async () => {
  const urls=[]
  const {page:records}=page('pages/record/record.js',{
    guard:()=>true,error(){},time:()=>'',
    request:async url=>{
      urls.push(url)
      const offset=Number(new URL('http://local'+url).searchParams.get('offset'))
      return {rows:Array.from({length:20},(_,i)=>({id:offset+i+1,startsAt:1,reviewStatus:'pending',experience:'长'.repeat(2000)})),total:200,hasMore:true,nextOffset:offset+20}
    },
  })
  await records.load();await records.more();await records.more()
  assert.equal(records.data.windowed,true)
  assert.equal(records.data.records.length,20)
  assert.equal(records.data.displayFrom,41)
  assert.equal(records.data.previousOffset,20)
  await records.previous()
  assert.match(urls.at(-1),/offset=20/)
  assert.equal(records.data.records[0].id,21)
  assert.ok(JSON.stringify(records.data).length<300000)
})

test('审计页使用游标追加，按钮事件刷新不会误当作加载更多', async () => {
  const urls = []
  const { page: audit } = page('pages/audit/audit.js', {
    guard: () => true, time: () => '时间', error() {},
    request: async url => {
      urls.push(url)
      return { rows: [{ id: 4 - urls.length, action: 'users.update', detail: {} }], hasMore: urls.length === 1, nextCursor: urls.length === 1 ? 3 : null }
    },
  })
  await audit.load()
  await audit.more()
  assert.equal(audit.data.rows.length, 2)
  assert.match(urls[1], /before=3/)
  await audit.load({ type: 'tap' })
  assert.equal(audit.data.rows.length, 1)
  assert.ok(!urls[2].includes('before='))
})

test('自行培训提交后只读，管理员认定学时走独立审核接口', async () => {
  let writes = 0
  const { page: training } = page('pages/self-training/self-training.js', {
    guard: () => true, error() {},
    request: async (url, method, body) => {
      if (method === 'POST') { writes++; assert.equal(body.requestedHours, 1.5); return { id: 10 } }
      return { id: 10, title: '培训', organizer: '主办方', occurredOn: '2026-11-01', requestedHours: 1.5, description: '经历', status: 'pending', proofs: [] }
    },
  })
  training.data.form.requestedHours = '1.5'
  training.data.proofs = [{ id: 'proof' }]
  await training.submit()
  await training.submit()
  assert.equal(writes, 1)
  assert.equal(training.data.readOnly, true)

  let route, payload
  const { page: reviews } = page('pages/reviews/reviews.js', {
    guard: () => true, error() {},
    request: async (url, method, body) => {
      if (method === 'POST') { route = url; payload = body; return {} }
      return { rows:[{ id:'external:1',reviewId:1,external:true,requestedHours:1.5,status:'pending' }],total:1,hasMore:false,pendingCount:1 }
    },
  }, { showModal: options => options.success({ confirm: true }) })
  await reviews.load()
  reviews.data.hours['external:1'] = '2.25'
  reviews.review({ currentTarget: { dataset: { id: 'external:1', status: 'approved' } } })
  await new Promise(setImmediate)
  assert.equal(route, '/api/admin/external-trainings/1/review')
  assert.equal(payload.creditHours, 2.25)
})

test('双重签到从相机扫码并获取 GCJ-02 定位，取消扫码不提交记录', async () => {
  for (const canceled of [false, true]) {
    let writes = 0, locations = 0, done = false
    const { page: attendance } = page('pages/attendance/attendance.js', {
      guard: () => true, time: () => '时间', error() {},
      request: async (path, method, body) => {
        if (method === 'POST') {
          writes++
          assert.equal(body.qrText, 'scan-result')
          assert.equal(body.latitude, 36.65)
          assert.equal(body.accuracy, 10)
          done = true
          return {}
        }
        return { sessions: [{ phase: 'in', method: 'both', active: true, closesAt: 1 }], records: done ? [{ phase: 'in', recordedAt: 1 }] : [] }
      },
    }, {
      scanCode: options => {
        assert.equal(options.onlyFromCamera, true)
        if (canceled) options.fail()
        else options.success({ result: 'scan-result' })
      },
      getLocation: options => {
        locations++
        assert.equal(options.type, 'gcj02')
        options.success({ latitude: 36.65, longitude: 117, accuracy: 10 })
      },
    })
    attendance.id = 1
    await attendance.load()
    const task = attendance.attend({ currentTarget: { dataset: { phase: 'in' } } })
    await attendance.attend({ currentTarget: { dataset: { phase: 'in' } } })
    await task
    assert.equal(writes, canceled ? 0 : 1)
    assert.equal(locations, canceled ? 0 : 1)
    assert.equal(attendance.data.busy, false)
  }
})

test('批量导入预览不暴露密码，失败保留已完成进度且不盲目重试', async () => {
  const { parseRosterCsv } = require('../utils/roster')
  const csv = '工号,姓名,学院/部门,初始密码\n' + Array.from({ length: 11 }, (_, i) => `000${i},老师,学院,School-Initial-2026`).join('\n')
  let calls = 0
  const { page: importer } = page('pages/user-import/user-import.js', {
    parseRosterCsv,
    error() {},
    request: async (url, method, body) => {
      calls++
      if (calls === 2) throw new Error('断网')
      return { imported: body.rows.length }
    },
  }, {
    chooseMessageFile: options => options.success({ tempFiles: [{ path: 'file', name: '名单.csv', size: csv.length }] }),
    getFileSystemManager: () => ({ readFile: options => options.success({ data: csv }) }),
  })
  importer.chooseFile()
  assert.equal(importer.data.rows.length, 11)
  assert.ok(!JSON.stringify(importer.data).includes('School-Initial-2026'))
  await importer.importRows()
  assert.equal(importer.data.imported, 10)
  assert.match(importer.data.errorMessage, /已完成 10 人/)
  await importer.importRows()
  assert.equal(calls, 2)
})

test('账号密码登录后首次强制改密，改密成功保存新会话', async () => {
  for (const mustChangePassword of [true, false]) {
    let target, saved
    const { page: login } = page('pages/login/login.js', {
      request: async (path, method, body) => {
        assert.equal(path, '/api/auth/login')
        assert.equal(body.id, '00001')
        assert.equal(body.password, 'Initial-Password-2026')
        return { token: 'new-token', mustChangePassword }
      },
      setToken: value => { saved = value }, error() {},
    }, { reLaunch: value => { target = value.url } })
    login.data.id = ' 00001 '
    login.data.password = 'Initial-Password-2026'
    await login.login()
    assert.equal(saved, 'new-token')
    assert.equal(target, mustChangePassword ? '/pages/password/password' : '/pages/index/index')
    assert.equal(login.data.password, '')
  }
  let calls = 0, saved
  const { page: password } = page('pages/password/password.js', {
    request: async () => { calls++; return { token: 'rotated' } },
    setToken: value => { saved = value }, error() {},
  }, { reLaunch() {} })
  password.data.oldPassword = 'Initial-Password-2026'
  password.data.newPassword = 'Personal-Password-2026'
  password.data.confirmPassword = 'different'
  await password.save()
  assert.equal(calls, 0)
  password.data.confirmPassword = password.data.newPassword
  await password.save()
  assert.equal(saved, 'rotated')
  assert.equal(password.data.oldPassword, '')
})

test('小程序相对 require 均指向可编译的 JavaScript 模块', () => {
  const root = path.join(__dirname, '..')
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        inspect(file)
        continue
      }
      if (!file.endsWith('.js')) continue
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        if (!match[1].startsWith('.')) continue
        assert.ok(!match[1].endsWith('.json'), file + ': 微信小程序不能按 Node 的方式 require JSON')
        const target = path.resolve(path.dirname(file), match[1])
        assert.ok(
          fs.existsSync(target.endsWith('.js') ? target : target + '.js'),
          file + ': ' + target,
        )
      }
    }
  }
  for (const folder of ['pages', 'utils', 'components']) inspect(path.join(root, folder))
})

function page(file, api, overrides = {}) {
  let config
  const messages = []
  const wx = {
    showToast: (value) => messages.push(value.title),
    navigateBack: (value) => value?.success?.(),
    redirectTo() {},
    ...overrides,
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    require: specifier => specifier.endsWith('/pagination') ? require('../utils/pagination') : api,
    Page: (value) => {
      config = value
    },
    wx,
    Date,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  })
  config.data = JSON.parse(JSON.stringify(config.data || {}))
  config.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  return { page: config, messages }
}

test('页面交互绑定都有对应的处理函数', () => {
  const root = path.join(__dirname, '..')
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages
  for (const route of pages) {
    const { page: instance } = page(route + '.js', {})
    const template = fs.readFileSync(path.join(root, route + '.wxml'), 'utf8')
    for (const match of template.matchAll(/\b(?:bind|catch)[a-z:]*="([A-Za-z_][A-Za-z_0-9]*)"/g)) {
      assert.equal(typeof instance[match[1]], 'function', route + ': ' + match[1])
    }
  }
})

test('统计入口及子页已注册，首页统计导航均指向有效页面', async () => {
  const root = path.join(__dirname, '..')
  const routes = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages
  for (const route of ['pages/stastic/static', 'pages/stastic/people/people', 'pages/stastic/ranking/ranking']) {
    assert.ok(routes.includes(route), route)
  }
  for (const route of ['pages/index/index', 'pages/stastic/static']) {
    const template = fs.readFileSync(path.join(root, route + '.wxml'), 'utf8')
    for (const match of template.matchAll(/<navigator\b[^>]*\burl="\/([^"?]+)"/g)) {
      assert.ok(routes.includes(match[1]), route + ': ' + match[1])
    }
  }
  for (const role of ['admin', 'counselor']) {
    const { page: hub } = page('pages/stastic/static.js', {
      guard: () => true, request: async () => ({ role }), error() {},
    })
    await hub.load()
    assert.equal(hub.data.authorized, role === 'admin')
  }
})

test('导航组件返回失败可回首页，并提供有效的首页处理方法', () => {
  let config
  let target
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../components/navigation-bar/navigation-bar.js'), 'utf8'),
    {
      Component: (value) => {
        config = value
      },
      wx: {
        navigateBack: (value) => value.fail(),
        switchTab: (value) => {
          target = value.url
        },
      },
    },
  )
  config.methods.onBack.call({ data: { delta: 1 }, triggerEvent() {} })
  assert.equal(target, '/pages/index/index')
  target = null
  config.methods.onHome()
  assert.equal(target, '/pages/index/index')
})

test('编辑页加载前不能误发布，加载后使用北京时间且防止重复保存', async () => {
  let release
  let writes = 0
  const api = {
    guard: () => true,
    error() {},
    request: async (url, method) => {
      if (url === '/api/me')
        return new Promise((resolve) => {
          release = resolve
        })
      if (method === 'PUT') {
        writes++
        return {}
      }
      return {
        id: 7,
        title: '活动',
        location: '',
        description: '',
        startsAt: Date.parse('2026-11-11T08:30:00+08:00'),
        endsAt: Date.parse('2026-11-11T10:30:00+08:00'),
        capacity: null,
        creditHours: 60,
      }
    },
  }
  const { page: editor, messages } = page('pages/activity-publish/activity-publish.js', api)
  editor.options = { id: '7' }
  const loading = editor.load()
  await editor.save()
  assert.equal(writes, 0)
  release({ role: 'admin' })
  await loading
  assert.equal(editor.data.editing, 7)
  assert.equal(editor.data.form.startTime, '08:30')
  editor.data.form.endTime = '07:00'
  await editor.save()
  assert.equal(writes, 0)
  assert.ok(messages.includes('结束时间须晚于开始时间'))
  editor.data.form.endTime = '10:30'
  await editor.save()
  await editor.save()
  assert.equal(writes, 1)
})

test('列表网络错误与空数据区分，重试后恢复', async () => {
  let offline = true
  const api = {
    guard: () => true,
    time: () => '时间',
    error() {},
    request: async () => {
      if (offline) throw new Error('网络不可用')
      return [{ id: 1, title: '活动', startsAt: 1, reviewStatus: 'pending' }]
    },
  }
  const { page: records } = page('pages/record/record.js', api)
  await records.load()
  assert.equal(records.data.loading, false)
  assert.equal(records.data.errorMessage, '网络不可用')
  offline = false
  await records.load()
  assert.equal(records.data.errorMessage, '')
  assert.equal(records.data.records.length, 1)
})

test('首页身份确认前隐藏底栏，仅普通用户确认后显示，旧请求不能恢复底栏', async () => {
  const pending = []
  const changes = []
  const api = {
    guard: () => true,
    error() {},
    format: value => value,
    request: url => url === '/api/me'
      ? new Promise((resolve, reject) => pending.push({resolve, reject}))
      : Promise.resolve(url === '/api/admin/review-count' ? {pendingCount:0} : []),
  }
  const {page: home} = page('pages/index/index.js', api, {
    hideTabBar: () => changes.push('hide'),
    showTabBar: () => changes.push('show'),
  })
  home.onLoad()
  assert.deepEqual(changes, ['hide'])
  const adminLoading = home.onShow()
  assert.equal(changes.at(-1), 'hide')
  assert.ok(!changes.includes('show'))
  pending.shift().resolve({role:'admin'})
  await adminLoading
  assert.ok(!changes.includes('show'))
  home.onHide()

  const userLoading = home.onShow()
  assert.equal(changes.at(-1), 'hide')
  pending.shift().resolve({role:'counselor'})
  await userLoading
  assert.equal(changes.at(-1), 'show')

  const staleLoading = home.onShow()
  const stale = pending.shift()
  home.onHide()
  const currentLoading = home.onShow()
  pending.shift().resolve({role:'admin'})
  await currentLoading
  stale.resolve({role:'counselor'})
  await staleLoading
  assert.equal(changes.at(-1), 'hide')
  assert.equal(home.data.user.role, 'admin')
  home.onHide()

  const offlineLoading = home.onShow()
  pending.shift().reject(new Error('网络不可用'))
  await offlineLoading
  assert.equal(changes.at(-1), 'hide')
  assert.equal(home.data.errorMessage, '网络不可用')
  home.onHide()
})
