const api = require('../../utils/store')
Page({
  data: { attendees: [] },
  onLoad(o) {
    this.id = o.id
    this.load()
  },
  async load() {
    if (!api.guard()) return
    try {
      this.setData({
        attendees: (await api.request('/api/admin/activities/' + this.id + '/attendees')).map(
          (x) => ({ ...x, registeredText: api.time(x.registeredAt) }),
        ),
      })
    } catch (e) {
      api.error(e)
    }
  },
  confirm(e) {
    const userId = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认参加',
      content: '确认该人员已经参加活动？确认后计入活动学时。',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await api.request('/api/admin/activities/' + this.id + '/confirm', 'POST', { userId })
          await this.load()
          wx.showToast({ title: '已确认参加' })
        } catch (err) {
          api.error(err)
        }
      },
    })
  },
})
