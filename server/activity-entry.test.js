const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')

function page(route, api, overrides = {}) {
  let result
  const navigations = []
  vm.runInNewContext(fs.readFileSync(path.join(root, route + '.js'), 'utf8'), {
    Page: value => { result = value },
    require: name => name.endsWith('/pagination') ? require('../utils/pagination') : api,
    wx: { navigateTo: value => navigations.push(value.url), ...overrides },
    Date,
    console,
  })
  result.data = JSON.parse(JSON.stringify(result.data || {}))
  result.setData = patch => Object.assign(result.data, patch)
  return { page: result, navigations }
}

test('自行活动新建入口只在活动中心，身份确认前或管理员身份不显示', async () => {
  let resolveIdentity
  const api = {
    guard: () => true,
    format: value => value,
    error() {},
    request: url => url === '/api/me'
      ? new Promise(resolve => { resolveIdentity = resolve })
      : Promise.resolve({ rows: [{ id: 1 }], total: 1, hasMore: false }),
  }
  const { page: center } = page('pages/course/list', api)
  await center.onShow()
  assert.equal(center.data.isCounselor, false)
  assert.equal(center.data.activities.length, 1)
  resolveIdentity({ role: 'counselor' })
  await new Promise(setImmediate)
  assert.equal(center.data.isCounselor, true)
  const checking = center.refreshIdentity()
  assert.equal(center.data.isCounselor, false)
  resolveIdentity({ role: 'admin' })
  await checking
  assert.equal(center.data.isCounselor, false)

  const template = fs.readFileSync(path.join(root, 'pages/course/list.wxml'), 'utf8')
  assert.match(template, /<navigator[^>]*wx:if="{{isCounselor}}"[^>]*url="\/pages\/self-training\/self-training"/)
  const records = fs.readFileSync(path.join(root, 'pages/record/record.wxml'), 'utf8')
  assert.ok(!records.includes('url="/pages/self-training/self-training"'))
})

test('隐藏页面后的旧身份响应不能把辅导员入口恢复给新管理员', async () => {
  const pending = []
  const { page: center } = page('pages/course/list', {
    error() {}, request: () => new Promise(resolve => pending.push(resolve)),
  })
  const old = center.refreshIdentity()
  center.onHide()
  const current = center.refreshIdentity()
  pending[1]({ role: 'admin' })
  await current
  pending[0]({ role: 'counselor' })
  await old
  assert.equal(center.data.isCounselor, false)
})

test('活动记录仍可查看自行培训详情和驳回后重新提交', () => {
  const { page: records, navigations } = page('pages/record/record', {})
  records.data.allRecords = [{ id: 'external:7', external: true, externalId: 7, reviewStatus: 'rejected', canSubmit: true }]
  const event = { currentTarget: { dataset: { id: 'external:7' } } }
  records.open(event)
  records.editExperience(event)
  assert.deepEqual(navigations, ['/pages/self-training/self-training?id=7', '/pages/self-training/self-training?id=7'])
})

test('活动管理可直接打开指定活动的签到签退设置，报名名单入口保留', () => {
  const { page: management, navigations } = page('pages/activity-manage/activity-manage', {})
  management.attendanceSettings({ currentTarget: { dataset: { id: 42 } } })
  assert.equal(navigations[0], '/pages/attendance-manage/attendance-manage?id=42')
  const template = fs.readFileSync(path.join(root, 'pages/activity-manage/activity-manage.wxml'), 'utf8')
  assert.match(template, /bindtap="attendanceSettings"/)
  assert.match(template, /bindtap="attendees"/)
})
