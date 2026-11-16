const api = require('../../utils/store')
Page({
  data: { oldPassword: '', newPassword: '', confirmPassword: '', busy: false },
  onShow() {
    api.guard()
  },
  input(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value })
  },
  async save() {
    if (this.data.busy) return
    const { oldPassword, newPassword, confirmPassword } = this.data
    if (newPassword.length < 8 || newPassword.length > 128 || newPassword !== confirmPassword) {
      wx.showToast({ title: '新密码须为 8—128 位且两次输入一致', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      const result = await api.request('/api/auth/password', 'POST', {
        oldPassword,
        newPassword,
      })
      api.setToken(result.token)
      this.setData({ oldPassword: '', newPassword: '', confirmPassword: '' })
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
})
