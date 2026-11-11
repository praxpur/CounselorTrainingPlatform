const api = require('../../utils/store')
Page({
  data: { loading: false, errorMessage: '', activity: null, busy: false },
  onLoad(options) {
    this.id = options.id
  },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '', activity: null })
    try {
      this.setData({ activity: api.format(await api.request('/api/activities/' + this.id)) })
    } catch (e) {
      this.setData({ errorMessage: e.message })
      api.error(e)
    } finally {
      this.setData({ loading: false })
    }
  },
  async register() {
    if (
      this.data.busy ||
      this.data.loading ||
      !this.data.activity ||
      !this.data.activity.canRegister
    )
      return
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
