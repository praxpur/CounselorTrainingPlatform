const api = require('../../../utils/store')
const { loadList } = require('../../../utils/pagination')
const currentYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
const years = Array.from({ length: 101 }, (_, index) => 2000 + index)

Page({
  data: {
    year: currentYear,
    years,
    yearIndex: currentYear - 2000,
    loadedYear: null,
    rows: [],
    errorMessage: '',
    loading: false,
    exporting: false,
  },
  onShow() {
    this.load()
  },
  changeYear(event) {
    const index = Number(event.detail.value)
    this.setData({ year: years[index], yearIndex: index, loadedYear: null, rows: [] })
    this.load()
  },
  async exportData() {
    if (this.data.exporting || this.data.loading || this.data.loadedYear !== this.data.year) return
    this.setData({ exporting: true })
    try {
      await api.exportExcel(
        '/api/admin/exports/ranking?year=' + this.data.year,
        this.data.year + '-年度学时排名.xlsx',
      )
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ exporting: false })
    }
  },
  load(append = false) {
    return loadList(this,api,{ path:'/api/admin/ranking?year='+this.data.year,field:'rows',append,
      start:{ loadedYear:null },after:report=>({ loadedYear:report.year }) })
  },
  previous(){return this.load({pageOffset:this.data.previousOffset})},
  more() { return this.load(true) },
})
