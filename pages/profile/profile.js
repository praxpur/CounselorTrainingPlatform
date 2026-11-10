const api = require('../../utils/store')
Page({
  data: { user: {} },
  async onShow() {
    if (!api.guard()) return
    try {
      const user = await api.request('/api/me')
      if (user.role === 'admin') {
        wx.switchTab({ url: '/pages/index/index' })
        return
      }
      this.setData({ user })
    } catch (e) {
      api.error(e)
    }
  },
  admin() {
    wx.navigateTo({ url: '/pages/admin/admin' })
  },
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await api.request('/api/logout', 'POST', {})
        } catch (e) {}
        api.clearToken()
        wx.reLaunch({ url: '/pages/login/login' })
      },
    })
  },
})
