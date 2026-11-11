const api = require('../../utils/store')
const currentYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
const years = Array.from({ length: 101 }, (_, index) => 2000 + index)
Page({
  data: {
    activities: [],
    year: currentYear,
    yearIndex: currentYear - 2000 + 1,
    yearOptions: ['全部年份', ...years.map((year) => year + '年')],
    errorMessage: '',
    loading: false,
  },
  onShow() {
    this.load()
  },
  changeYear(event) {
    const yearIndex = Number(event.detail.value)
    this.setData({ yearIndex, year: yearIndex === 0 ? null : years[yearIndex - 1], activities: [] })
    this.load()
  },
  async load() {
    if (!api.guard()) return
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ loading: true, errorMessage: '' })
    try {
      const path = '/api/activities' + (this.data.year === null ? '' : '?year=' + this.data.year)
      const activities = await api.request(path)
      if (this.requestId === requestId) this.setData({ activities: activities.map(api.format) })
    } catch (e) {
      if (this.requestId === requestId) {
        this.setData({ errorMessage: e.message })
        api.error(e)
      }
    } finally {
      if (this.requestId === requestId) this.setData({ loading: false })
    }
  },
  open(e) {
    wx.navigateTo({ url: '/pages/course/detail?id=' + e.currentTarget.dataset.id })
  },
})
