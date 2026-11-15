const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')
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
  load(append = false) {
    const path = '/api/activities' + (this.data.year === null ? '' : '?year=' + this.data.year)
    return loadList(this,api,{ path,field:'activities',map:api.format,append })
  },
  previous(){return this.load({pageOffset:this.data.previousOffset})},
  more() { return this.load(true) },
  open(e) {
    wx.navigateTo({ url: '/pages/course/detail?id=' + e.currentTarget.dataset.id })
  },
})
