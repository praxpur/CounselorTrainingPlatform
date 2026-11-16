const api = require('../../utils/store')
Page({
  data: { id: '', password: '', loading: false },
  input(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value })
  },
  async login() {
    if (this.data.loading) return
    if (!this.data.id.trim() || !this.data.password) {
      wx.showToast({ title: '请填写工号和密码', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    try {
      const result = await api.request('/api/auth/login', 'POST', {
        id: this.data.id.trim(),
        password: this.data.password,
      })
      api.setToken(result.token)
      this.setData({ password: '' })
      wx.reLaunch({
        url: result.mustChangePassword ? '/pages/password/password' : '/pages/index/index',
      })
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ loading: false })
    }
  },
})
