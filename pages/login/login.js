const api = require('../../utils/store')
Page({
  data: { id: '', name: '', department: '', loading: false },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  async login() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const result = await api.request('/api/auth/dev', 'POST', {
        id: this.data.id,
        name: this.data.name,
        department: this.data.department,
      })
      api.setToken(result.token)
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none', duration: 3000 })
    } finally {
      this.setData({ loading: false })
    }
  },
})
