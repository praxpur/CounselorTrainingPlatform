const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

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
    require: () => api,
    Page: (value) => {
      config = value
    },
    wx,
    Date,
    console,
    setInterval,
    clearInterval,
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
        creditMinutes: 60,
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

test('年度统计快速切换时旧响应不覆盖新年份，失败后不能导出旧数据', async () => {
  const pending = []
  const api = {
    guard: () => true,
    error() {},
    request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  }
  const { page: ranking } = page('pages/stastic/ranking/ranking.js', api)
  ranking.changeYear({ detail: { value: '25' } })
  ranking.changeYear({ detail: { value: '24' } })
  pending[1].resolve({ year: 2024, rows: [{ id: 'new' }] })
  await new Promise(setImmediate)
  pending[0].resolve({ year: 2025, rows: [{ id: 'old' }] })
  await new Promise(setImmediate)
  assert.equal(ranking.data.loadedYear, 2024)
  assert.equal(ranking.data.rows[0].id, 'new')
  const refreshing = ranking.load()
  pending[2].reject(new Error('断网'))
  await refreshing
  assert.equal(ranking.data.loadedYear, null)
  assert.equal(ranking.data.errorMessage, '断网')
})

test('字体下载失败后节流重试，字体错误不应中断 API 数据请求', async () => {
  let now = 0
  const requests = []
  const sandbox = {
    require: () => '王',
    module: { exports: {} },
    Set,
    Date: { now: () => now },
    console: { warn() {} },
    wx: { loadFontFace: (value) => requests.push(value) },
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/fonts.js'), 'utf8'), sandbox)
  const ensure = sandbox.module.exports.ensureFontForText
  ensure({ name: '龘' }, 'http://localhost')
  requests[0].fail(new Error('offline'))
  ensure({ name: '龘' }, 'http://localhost')
  assert.equal(requests.length, 1)
  now = 31000
  ensure({ name: '龘' }, 'http://localhost')
  assert.equal(requests.length, 2)
  requests[1].success()
  ensure({ name: '龘' }, 'http://localhost')
  assert.equal(requests.length, 2)
  const store = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/store.js'), 'utf8'), {
    require: () => ({
      ensureFontForText: () => {
        throw new Error('unsupported font')
      },
    }),
    module: store,
    Date,
    console: { warn() {} },
    wx: {
      getStorageSync: () => 'token',
      request: (request) => request.success({ statusCode: 200, data: { ok: true } }),
    },
  })
  assert.equal((await store.exports.request('/test')).ok, true)
  assert.equal(store.exports.time(Date.parse('2024-12-31T23:30:00Z')), '2025-01-01 07:30')
})
