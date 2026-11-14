const api = require('../../../utils/store')
Page({
  data: {
    loading: false,
    errorMessage: '',
    people: [],
    visiblePeople: [],
    query: '',
    selected: null,
    records: [],
  },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      this.setData({ people: await api.request('/api/admin/people') })
      this.filterPeople()
    } catch (e) {
      this.setData({ errorMessage: e.message })
      api.error(e)
    } finally {
      this.setData({ loading: false })
    }
  },
  async select(e) {
    const id = e.currentTarget.dataset.id
    this.selectedRequest = (this.selectedRequest || 0) + 1
    const requestId = this.selectedRequest
    this.setData({ loading: true, errorMessage: '' })
    try {
      const records = await api.request('/api/admin/person-records?id=' + encodeURIComponent(id))
      if (this.selectedRequest !== requestId) return
      this.setData({
        selected: this.data.people.find((p) => p.id === id),
        records: records.map(api.format),
      })
    } catch (err) {
      this.setData({ errorMessage: err.message })
      api.error(err)
    } finally {
      if (this.selectedRequest === requestId) this.setData({ loading: false })
    }
  },
  search(event) {
    this.setData({ query: event.detail.value })
    this.filterPeople()
  },
  filterPeople() {
    const query = this.data.query.trim().toLowerCase()
    this.setData({
      visiblePeople: this.data.people.filter((person) =>
        [person.id, person.name, person.department].some((value) =>
          value.toLowerCase().includes(query),
        ),
      ),
    })
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
    this.selectedRequest = (this.selectedRequest || 0) + 1
    this.setData({ selected: null, records: [] })
  },
})
