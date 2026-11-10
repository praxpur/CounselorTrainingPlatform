const api = require('../../utils/store')
Page({
  data: { activity: null, busy: false },
  onLoad(options) {
    this.id = options.id
    this.load()
  },
  async load() {
    if (!api.guard()) return
    try {
      this.setData({ activity: api.format(await api.request('/api/activities/' + this.id)) })
    } catch (e) {
      api.error(e)
    }
  },
  async register() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      this.setData({
        activity: api.format(
          await api.request('/api/activities/' + this.id + '/register', 'POST', {}),
        ),
      })
      wx.showToast({ title: '报名成功' })
    } catch (e) {
      api.error(e)
      this.load()
    } finally {
      this.setData({ busy: false })
    }
  },
})
