const api = require('../../utils/store')
const actions = ['', 'auth.login', 'users.update', 'activities.update', 'experiences.update', 'external_trainings.update', 'data.export']
const labels = { users: '人员', activities: '活动', registrations: '报名与参加', experiences: '培训经历',
  external_trainings: '自行培训', credentials: '密码凭据', sessions: '登录会话', proof_files: '证明材料',
  attendance_sessions: '签到设置', attendance_records: '签到记录' }
function actionLabel(action) {
  const [table, operation] = action.split('.')
  return labels[table] ? labels[table] + ({ insert: '新增', update: '修改', delete: '移除' }[operation] || '') :
    ({ 'auth.login': '账号登录', 'auth.password.change': '修改密码', 'data.export': '数据导出', 'audit.read': '查看审计日志', 'proof.download': '材料下载', 'request.write': '接口操作', 'request.denied': '拒绝访问' }[action] || action)
}
Page({
  data: { loading: false, errorMessage: '', rows: [], actor: '', actionIndex: 0,
    actionLabels: ['全部操作','账号登录','人员修改','活动修改','培训经历审核','自行培训审核','数据导出'], nextCursor: null, hasMore: false },
  onShow() { this.load() },
  input(event) { this.setData({ actor: event.detail.value }) },
  changeAction(event) { this.setData({ actionIndex: Number(event.detail.value) }); this.load() },
  more() { if (!this.data.loading && this.data.hasMore) return this.load(true) },
  async load(append = false) {
    if (!api.guard()) return
    // bindretry/bindtap 会传事件对象，只有布尔 true 代表追加。
    append = append === true
    if (append && this.data.loading) return
    const requestId = (this.requestId || 0) + 1; this.requestId = requestId
    const cursor = append ? this.data.nextCursor : null
    this.setData({ loading: true, errorMessage: '', ...(append ? {} : { rows: [], hasMore: false, nextCursor: null }) })
    try {
      const result = await api.request('/api/admin/audit-logs?limit=50&actor=' + encodeURIComponent(this.data.actor.trim()) + '&action=' + encodeURIComponent(actions[this.data.actionIndex] || '') + (cursor ? '&before=' + cursor : ''))
      if (requestId !== this.requestId) return
      const rows = result.rows.map(row => ({ ...row, timeText: api.time(row.happenedAt), label: actionLabel(row.action), detailText: JSON.stringify(row.detail, null, 2) }))
      this.setData({ rows: append ? [...this.data.rows, ...rows] : rows, nextCursor: result.nextCursor, hasMore: result.hasMore })
    } catch (error) { if (requestId === this.requestId) { this.setData({ errorMessage: error.message }); api.error(error) } }
    finally { if (requestId === this.requestId) this.setData({ loading: false }) }
  },
})
