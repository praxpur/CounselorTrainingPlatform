const api = require('../../utils/store')
Page({
  data: { records: [] },
  async onShow() {
    if (!api.guard()) return
    try {
      this.setData({ records: (await api.request('/api/records')).map(api.format) })
    } catch (e) {
      api.error(e)
    }
  },
  open(e) {
    wx.navigateTo({ url: '/pages/course/detail?id=' + e.currentTarget.dataset.id })
  },
})
