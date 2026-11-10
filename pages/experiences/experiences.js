const api = require('../../utils/store')
Page({
  data: { activities: [], index: -1, description: '', records: [], busy: false },
  onShow() {
    this.load()
  },
  choose(e) {
    this.setData({ index: Number(e.detail.value) })
  },
  input(e) {
    this.setData({ description: e.detail.value })
  },
  async load() {
    if (!api.guard()) return
    try {
      const [records, activities] = await Promise.all([
        api.request('/api/experiences'),
        api.request('/api/records'),
      ])
      this.setData({ records, activities: activities.filter((a) => a.status === 'published') })
    } catch (e) {
      api.error(e)
    }
  },
  async submit() {
    if (this.data.busy) return
    if (this.data.index < 0) {
      wx.showToast({ title: '请选择已报名的活动', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      await api.request('/api/experiences', 'POST', {
        activityId: this.data.activities[this.data.index].id,
        description: this.data.description,
      })
      this.setData({ index: -1, description: '' })
      await this.load()
      wx.showToast({ title: '已提交审核' })
    } catch (e) {
      api.error(e)
    } finally {
      this.setData({ busy: false })
    }
  },
})
