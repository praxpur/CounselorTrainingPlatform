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
  withdraw() {
    if (this.data.busy || this.data.loading || !this.data.activity?.canWithdraw) return
    this.setData({ busy: true })
    wx.showModal({
      title: '取消报名',
      content: '活动开始前可取消，取消后立即释放名额并保留历史记录。确定取消？',
      success: async (result) => {
        if (!result.confirm) {
          this.setData({ busy: false })
          return
        }
        try {
          const activity = await api.request('/api/activities/' + this.id + '/register', 'DELETE')
          this.setData({ activity: api.format(activity) })
          wx.showToast({ title: '已取消报名' })
        } catch (error) {
          api.error(error)
          await this.load()
        } finally {
          this.setData({ busy: false })
        }
      },
      fail: () => this.setData({ busy: false }),
    })
  },
})
