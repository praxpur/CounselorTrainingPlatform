const api = require('../../utils/store')
const years = Array.from({ length: 101 }, (_, index) => 2000 + index)
const currentYear = new Date().getFullYear()

Page({
  data: {
    year: currentYear,
    years,
    yearIndex: currentYear - 2000,
    report: null,
    months: [],
    records: [],
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
  async load() {
    if (!api.guard()) return
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ loading: true })
    try {
      const report = await api.request('/api/my/annual?year=' + this.data.year)
      if (this.requestId !== requestId) return
      const max = Math.max(1, ...report.months.map((month) => month.minutes))
      this.setData({
        report,
        months: report.months.map((month) => ({
          ...month,
          width: Math.round((month.minutes / max) * 100),
        })),
        records: report.records.map((record) => ({
          ...record,
          startsText: api.time(record.startsAt),
        })),
      })
    } catch (error) {
      if (this.requestId === requestId) api.error(error)
    } finally {
      if (this.requestId === requestId) this.setData({ loading: false })
    }
  },
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
