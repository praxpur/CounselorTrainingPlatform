const api = require('../../utils/store')
Page({
  data: { activities: [] },
  async onShow() {
    if (!api.guard()) return
    try {
      this.setData({ activities: (await api.request('/api/activities')).map(api.format) })
    } catch (e) {
      api.error(e)
    }
  },
  open(e) {
    wx.navigateTo({ url: '/pages/course/detail?id=' + e.currentTarget.dataset.id })
  },
})
