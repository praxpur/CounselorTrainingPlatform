const api = require('../../utils/store')
Page({
  data: { activities: [] },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    try {
      this.setData({ activities: (await api.request('/api/admin/activities')).map(api.format) })
    } catch (error) {
      api.error(error)
    }
  },
  create() {
    wx.navigateTo({ url: '/pages/admin/publish' })
  },
  edit(event) {
    wx.navigateTo({ url: '/pages/admin/publish?id=' + event.currentTarget.dataset.id })
  },
  attendees(event) {
    wx.navigateTo({ url: '/pages/attendees/attendees?id=' + event.currentTarget.dataset.id })
  },
  cancel(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '取消活动',
      content: '取消后无法恢复，已有报名记录会保留。确定取消？',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await api.request('/api/admin/activities/' + id, 'DELETE')
          this.load()
        } catch (err) {
          api.error(err)
        }
      },
    })
  },
})
