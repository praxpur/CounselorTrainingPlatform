const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')
Page({
  data: {
    loading: false,
    errorMessage: '',
    records: [],
    notes: {},
    hours: {},
    busy: false,
    pendingCount: 0,
    showAll: false,
  },
  onShow() {
    this.load()
  },
  load(append = false) {
    return loadList(this, api, {
      path: '/api/admin/reviews' + (this.data.showAll ? '' : '?status=pending'),
      field: 'records',
      append,
      after: (report, rows) => {
        const notes = { ...this.data.notes },
          hours = { ...this.data.hours }
        this.draftVersions ||= {}
        for (const record of rows) {
          const version = JSON.stringify(record)
          if (this.draftVersions[record.id] && this.draftVersions[record.id] !== version) {
            delete notes[record.id]
            delete hours[record.id]
          }
          this.draftVersions[record.id] = version
        }
        const retained = new Set(rows.map((record) => String(record.id)))
        for (const id of Object.keys(this.draftVersions))
          if (!retained.has(id) && notes[id] === undefined && hours[id] === undefined)
            delete this.draftVersions[id]
        return { notes, hours, pendingCount: report.pendingCount }
      },
    })
  },
  previous() {
    return this.load({ pageOffset: this.data.previousOffset })
  },
  more() {
    return this.load(true)
  },
  toggleRecords() {
    this.setData({ showAll: !this.data.showAll })
    return this.load()
  },
  input(e) {
    const values = { ...this.data.notes, [e.currentTarget.dataset.id]: e.detail.value }
    this.setData({ notes: values })
  },
  inputHours(event) {
    this.setData({
      hours: { ...this.data.hours, [event.currentTarget.dataset.id]: event.detail.value },
    })
  },
  review(e) {
    if (this.data.busy) return
    const id = e.currentTarget.dataset.id,
      status = e.currentTarget.dataset.status,
      note = this.data.notes[id] || ''
    const record = this.data.records.find((value) => value.id === id)
    if (!record) return
    const creditHours = Number(this.data.hours[id] ?? record.requestedHours)
    if (status === 'rejected' && !note.trim()) {
      wx.showToast({ title: '请填写驳回原因', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认审核',
      content: status === 'approved' ? '确认通过并确认参加该活动？' : '确认驳回该培训经历？',
      success: async (r) => {
        if (!r.confirm || this.data.busy) return
        this.setData({ busy: true })
        try {
          const route = record.external
            ? '/api/admin/external-trainings/' + record.reviewId
            : '/api/admin/experiences/' + record.reviewId
          await api.request(route + '/review', 'POST', { status, note, creditHours })
          const notes = { ...this.data.notes },
            hours = { ...this.data.hours }
          delete notes[id]
          delete hours[id]
          this.setData({ notes, hours })
          await this.load()
          wx.showToast({ title: '审核完成' })
        } catch (err) {
          api.error(err)
        } finally {
          this.setData({ busy: false })
        }
      },
    })
  },
})
