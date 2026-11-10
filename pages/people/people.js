const api = require('../../utils/store')
Page({
  data: { people: [], selected: null, records: [] },
  async onLoad() {
    if (!api.guard()) return
    try {
      this.setData({ people: await api.request('/api/admin/people') })
    } catch (e) {
      api.error(e)
    }
  },
  async select(e) {
    const id = e.currentTarget.dataset.id
    try {
      this.setData({
        selected: this.data.people.find((p) => p.id === id),
        records: (await api.request('/api/admin/person-records?id=' + encodeURIComponent(id))).map(
          api.format,
        ),
      })
    } catch (err) {
      api.error(err)
    }
  },
  async exportData() {
    if (this.data.exporting) return
    this.setData({ exporting: true })
    try {
      await api.exportExcel('/api/admin/exports/people', '人员报名情况.xlsx')
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ exporting: false })
    }
  },
  back() {
    this.setData({ selected: null, records: [] })
  },
})
