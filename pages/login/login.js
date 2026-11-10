const api = require('../../utils/store')
Page({
  data: { id: '', name: '', department: '', departmentRequired: false, loading: false },
  input(e) {
    const field = e.currentTarget.dataset.field
    if (field === 'id' && e.detail.value !== this.data.id) {
      this.setData({ id: e.detail.value, department: '', departmentRequired: false })
      return
    }
    this.setData({ [field]: e.detail.value })
  },
  async login() {
    if (this.data.loading) return
    if (!this.data.id.trim() || !this.data.name.trim()) {
      wx.showToast({ title: '请填写工号和姓名', icon: 'none' })
      return
    }
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
      if (e.code === 'DEPARTMENT_REQUIRED') {
        this.setData({ departmentRequired: true })
      }
      wx.showToast({ title: e.message, icon: 'none', duration: 3000 })
    } finally {
      this.setData({ loading: false })
    }
  },
})
