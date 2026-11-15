const api = require('../../utils/store')

Page({
  data: { user: null, activities: [], loading: true, pendingCount: 0, errorMessage: '' },
  async onShow() {
    this.pageVisible = true
    this.stopReviewTimer()
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '', user: null, activities: [] })
    try {
      const user = await api.request('/api/me')
      if (user.role === 'admin') {
        wx.hideTabBar({ animation: false })
        this.setData({ user, loading: false })
        const refreshed = await this.refreshReviewCount()
        if (refreshed && this.pageVisible)
          this.reviewTimer = setInterval(() => this.refreshReviewCount(), 30000)
      } else {
        wx.showTabBar({ animation: false })
        this.setData({ user })
        const result = await api.request('/api/activities?limit=5&offset=0')
        const activities = Array.isArray(result) ? result : result.rows
        this.setData({ activities: activities.slice(0, 5).map(api.format), loading: false })
      }
    } catch (e) {
      this.setData({ loading: false, errorMessage: e.message })
      api.error(e)
    }
  },
  onHide() {
    this.pageVisible = false
    this.stopReviewTimer()
  },
  onUnload() {
    this.pageVisible = false
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
      return true
    } catch (error) {
      this.stopReviewTimer()
      api.error(error)
      this.setData({ errorMessage: error.message })
      return false
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
