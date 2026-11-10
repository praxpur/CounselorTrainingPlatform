const api = require('../../utils/store')
const currentYear = new Date().getFullYear()
const years = Array.from({ length: 101 }, (_, index) => 2000 + index)

Page({
  data: {
    year: currentYear,
    years,
    yearIndex: currentYear - 2000,
    loadedYear: null,
    rows: [],
    loading: false,
    exporting: false,
  },
  onLoad() {
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
  async load() {
    if (!api.guard()) return
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ loading: true })
    try {
      const report = await api.request('/api/admin/ranking?year=' + this.data.year)
      if (this.requestId !== requestId) return
      this.setData({ loadedYear: report.year, rows: report.rows })
    } catch (error) {
      if (this.requestId === requestId) api.error(error)
    } finally {
      if (this.requestId === requestId) this.setData({ loading: false })
    }
  },
})
