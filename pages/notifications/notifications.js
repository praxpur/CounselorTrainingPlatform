const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')
const safePage =
  /^\/pages\/(?:course\/detail\?id=[1-9]\d*|self-training\/self-training\?id=[1-9]\d*|reviews\/reviews|password\/password|activity-manage\/activity-manage)$/
Page({
  data: {
    rows: [],
    loading: false,
    busy: false,
    errorMessage: '',
    unreadOnly: false,
    unreadCount: 0,
    snapshot: null,
    hasNewer: false,
  },
  onShow() {
    this.load()
  },
  load(append = false) {
    const continuing = append === true || Number.isInteger(append?.pageOffset)
    const params = []
    if (this.data.unreadOnly) params.push('unread=1')
    if (continuing && this.data.snapshot !== null) params.push('snapshot=' + this.data.snapshot)
    return loadList(this, api, {
      path: '/api/notifications' + (params.length ? '?' + params.join('&') : ''),
      field: 'rows',
      append,
      start: { snapshot: null, hasNewer: false },
      map: (row) => ({ ...row, timeText: api.time(row.createdAt) }),
      after: (result) => ({
        unreadCount: Number(result.unreadCount) || 0,
        snapshot: result.snapshot ?? null,
        hasNewer: Boolean(result.hasNewer),
      }),
    })
  },
  more() {
    if (!this.data.busy) return this.load(true)
  },
  previous() {
    if (!this.data.busy) return this.load({ pageOffset: this.data.previousOffset })
  },
  toggleUnread() {
    if (this.data.busy || this.data.loading) return
    this.setData({ unreadOnly: !this.data.unreadOnly })
    return this.load()
  },
  async open(event) {
    if (this.data.busy || this.data.loading) return
    const id = event.currentTarget.dataset.id
    if (!this.data.rows.some((row) => String(row.id) === String(id))) return
    this.setData({ busy: true })
    try {
      const result = await api.request(
        '/api/notifications/' + encodeURIComponent(id) + '/read',
        'POST',
        {},
      )
      this.setData({
        unreadCount: result.unreadCount,
        rows: this.data.rows.map((row) =>
          String(row.id) === String(id) ? { ...row, readAt: result.readAt } : row,
        ),
      })
      if (this.data.unreadOnly) await this.load()
      const target = result.target
      if (!target) return
      const fail = () => api.error(new Error('通知入口暂不可用，请从相关页面查看'))
      if (target.tab === true && target.url === '/pages/record/record')
        wx.switchTab({ url: target.url, fail })
      else if (target.tab === false && safePage.test(target.url || ''))
        wx.navigateTo({ url: target.url, fail })
      else fail()
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
  async readAll() {
    if (this.data.busy || this.data.loading || !this.data.unreadCount) return
    this.setData({ busy: true })
    try {
      const result = await api.request('/api/notifications/read-all', 'POST', {})
      this.setData({
        unreadCount: result.unreadCount,
        rows: this.data.rows.map((row) => ({
          ...row,
          readAt: row.readAt ?? result.readAt,
        })),
      })
      if (this.data.unreadOnly) await this.load()
      wx.showToast({ title: '已全部标为已读' })
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
})
