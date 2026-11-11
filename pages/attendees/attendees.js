const api = require('../../utils/store')
Page({
  data: { loading: false, errorMessage: '', attendees: [], confirming: false, activity: null },
  onLoad(o) {
    this.id = o.id
  },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const [activity, attendees] = await Promise.all([
        api.request('/api/activities/' + this.id),
        api.request('/api/admin/activities/' + this.id + '/attendees'),
      ])
      this.setData({
        activity,
        canConfirm: activity.status === 'published' && activity.startsAt <= Date.now(),
        attendees: attendees.map((x) => ({ ...x, registeredText: api.time(x.registeredAt) })),
      })
    } catch (e) {
      this.setData({ errorMessage: e.message })
      api.error(e)
    } finally {
      this.setData({ loading: false })
    }
  },
  confirm(e) {
    if (this.data.confirming || !this.data.canConfirm) return
    this.setData({ confirming: true })
    const userId = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认参加',
      content: '确认该人员已经参加活动？确认后计入活动学时。',
      success: async (r) => {
        if (!r.confirm) {
          this.setData({ confirming: false })
          return
        }
        try {
          await api.request('/api/admin/activities/' + this.id + '/confirm', 'POST', { userId })
          await this.load()
          wx.showToast({ title: '已确认参加' })
        } catch (err) {
          api.error(err)
        } finally {
          this.setData({ confirming: false })
        }
      },
      fail: () => this.setData({ confirming: false }),
    })
  },
})
