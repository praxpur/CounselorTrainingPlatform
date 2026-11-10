const api = require('../../utils/store')
Page({
  data: { year: new Date().getFullYear(), rows: [] },
  onLoad() {
    this.load()
  },
  async exportData() {
    if (this.data.exporting) return
    this.setData({ exporting: true })
    try {
      await api.exportExcel(
        '/api/admin/exports/ranking?year=' + encodeURIComponent(this.data.year),
        this.data.year + '-年度学时排名.xlsx',
      )
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ exporting: false })
    }
  },
  input(e) {
    this.setData({ year: e.detail.value })
  },
  async load() {
    if (!api.guard()) return
    try {
      const r = await api.request('/api/admin/ranking?year=' + encodeURIComponent(this.data.year))
      this.setData({ year: r.year, rows: r.rows })
    } catch (e) {
      api.error(e)
    }
  },
})
