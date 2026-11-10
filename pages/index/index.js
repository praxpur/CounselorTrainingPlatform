const api = require('../../utils/store')

Page({
  data: { user: null, activities: [], loading: true, pendingCount: 0 },
  async onShow() {
    this.stopReviewTimer()
    if (!api.guard()) return
    this.setData({ loading: true, user: null, activities: [] })
    try {
      const user = await api.request('/api/me')
      if (user.role === 'admin') {
        wx.hideTabBar({ animation: false })
        this.setData({ user, loading: false })
        await this.refreshReviewCount()
        this.reviewTimer = setInterval(() => this.refreshReviewCount(), 30000)
      } else {
        wx.showTabBar({ animation: false })
        this.setData({ user, loading: false })
        const activities = await api.request('/api/activities')
        this.setData({ activities: activities.slice(0, 5).map(api.format) })
      }
    } catch (e) {
      this.setData({ loading: false })
      api.error(e)
    }
  },
  onHide() {
    this.stopReviewTimer()
  },
  onUnload() {
    this.stopReviewTimer()
  },
  stopReviewTimer() {
    if (this.reviewTimer) clearInterval(this.reviewTimer)
    this.reviewTimer = null
  },
  async refreshReviewCount() {
    try {
      const result = await api.request('/api/admin/review-count')
      this.setData({ pendingCount: result.pendingCount })
    } catch (error) {
      this.stopReviewTimer()
      api.error(error)
    }
  },
  open(e) {
    wx.navigateTo({ url: '/pages/course/detail?id=' + e.currentTarget.dataset.id })
  },
  more() {
    wx.switchTab({ url: '/pages/course/list' })
  },
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      success: async (result) => {
        if (!result.confirm) return
        try {
          await api.request('/api/logout', 'POST', {})
        } catch (e) {}
        api.clearToken()
        wx.reLaunch({ url: '/pages/login/login' })
      },
    })
  },
})
