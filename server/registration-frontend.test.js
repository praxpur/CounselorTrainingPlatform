const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function formatActivity(value) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/store.js'), 'utf8'), {
    module, Date, console, wx: {}, require: () => ({ ensureFontForText() {} }),
  })
  return module.exports.format(value)
}
function loadDetail(api) {
  let config, modal
  const messages = []
  let dialogs = 0
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/course/detail.js'), 'utf8'), {
    Page: value => { config = value }, require: () => api,
    wx: {
      showModal: value => { modal = value; dialogs++ },
      showToast: value => messages.push(value.title),
    },
  })
  config.data = JSON.parse(JSON.stringify(config.data))
  config.setData = function (value) { Object.assign(this.data, value) }
  config.id = '8'
  return { page: config, messages, modal: () => modal, dialogs: () => dialogs }
}
const activity = () => ({ id: 8, status: 'published', registered: true, confirmedAt: null,
  registeredCount: 1, capacity: 1, startsAt: Date.now() + 3600000, endsAt: Date.now() + 7200000 })

test('取消对话框防重复，确认后更新详情并允许再次报名', async () => {
  let writes = 0
  const { page, modal, dialogs, messages } = loadDetail({
    format: formatActivity, guard: () => true, error() {},
    request: async (route, method) => {
      assert.equal(route, '/api/activities/8/register')
      assert.equal(method, 'DELETE')
      writes++
      return { ...activity(), registered: false, withdrawnAt: Date.now(), registeredCount: 0 }
    },
  })
  page.data.activity = formatActivity(activity())
  page.withdraw()
  page.withdraw()
  assert.equal(dialogs(), 1)
  await modal().success({ confirm: true })
  assert.equal(writes, 1)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.activity.registered, false)
  assert.equal(page.data.activity.canWithdraw, false)
  assert.equal(page.data.activity.canRegister, true)
  assert.ok(messages.includes('已取消报名'))
})

test('放弃对话框不发送请求，开始后或已确认参加不显示自主取消能力', async () => {
  let writes = 0
  const view = loadDetail({ format: formatActivity, request: async () => { writes++ } })
  view.page.data.activity = formatActivity(activity())
  view.page.withdraw()
  await view.modal().success({ confirm: false })
  assert.equal(writes, 0)
  assert.equal(view.page.data.busy, false)
  for (const patch of [{ startsAt: Date.now() - 1 }, { confirmedAt: Date.now() }, { status: 'cancelled' }]) {
    view.page.data.activity = formatActivity({ ...activity(), ...patch })
    assert.equal(view.page.data.activity.canWithdraw, false)
    view.page.withdraw()
  }
  assert.equal(view.dialogs(), 1)
})
