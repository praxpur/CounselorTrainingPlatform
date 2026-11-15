const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')
const years = Array.from({ length: 101 }, (_, index) => 2000 + index)
const currentYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear()

Page({
  data: {
    year: currentYear,
    years,
    yearIndex: currentYear - 2000,
    report: null,
    months: [],
    records: [],
    errorMessage: '',
    loading: false,
    exporting: false,
  },
  onShow() {
    this.load()
  },
  changeYear(event) {
    const yearIndex = Number(event.detail.value)
    this.setData({ yearIndex, year: years[yearIndex], report: null, months: [], records: [] })
    this.load()
  },
  load(append = false) {
    return loadList(this,api,{ path:'/api/my/annual?year='+this.data.year,field:'records',rowsKey:'records',append,
      start:{ report:null,months:[] },map:record=>({ ...record,startsText:api.time(record.startsAt) }),
      after:(report,rows)=>{
        const max=Math.max(1,...report.months.map(month=>month.hours))
        return { report:{ ...report,records:rows },months:report.months.map(month=>({ ...month,width:Math.round(month.hours/max*100) })) }
      } })
  },
  previous(){return this.load({pageOffset:this.data.previousOffset})},
  more() { return this.load(true) },
  async exportData() {
    if (this.data.exporting || this.data.loading || !this.data.report) return
    this.setData({ exporting: true })
    try {
      await api.exportExcel(
        '/api/my/exports/annual?year=' + this.data.year,
        this.data.year + '-我的年度学时.xlsx',
      )
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ exporting: false })
    }
  },
})
