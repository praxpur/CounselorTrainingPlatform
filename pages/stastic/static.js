const api = require('../../utils/store')

Page({
  data: { loading: true, errorMessage: '', authorized: false },
  onShow() {
    return this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '', authorized: false })
    try {
      const user = await api.request('/api/me')
      if (user.role !== 'admin') throw new Error('无管理员权限')
      this.setData({ authorized: true })
    } catch (error) {
      this.setData({ errorMessage: error.message })
      api.error(error)
    } finally {
      this.setData({ loading: false })
    }
  },
})
