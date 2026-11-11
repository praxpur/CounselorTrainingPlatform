const api = require('../../utils/store')
Page({
  data: {
    loading: false,
    errorMessage: '',
    records: [],
    allRecords: [],
    notes: {},
    busy: false,
    pendingCount: 0,
    showAll: false,
  },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '', records: [], allRecords: [] })
    try {
      const records = await api.request('/api/admin/experiences')
      this.setData({
        allRecords: records,
        pendingCount: records.filter((record) => record.status === 'pending').length,
        records: this.data.showAll
          ? records
          : records.filter((record) => record.status === 'pending'),
      })
    } catch (e) {
      this.setData({ errorMessage: e.message })
      api.error(e)
    } finally {
      this.setData({ loading: false })
    }
  },
  toggleRecords() {
    const showAll = !this.data.showAll
    this.setData({
      showAll,
      records: showAll
        ? this.data.allRecords
        : this.data.allRecords.filter((record) => record.status === 'pending'),
    })
  },
  input(e) {
    const values = { ...this.data.notes, [e.currentTarget.dataset.id]: e.detail.value }
    this.setData({ notes: values })
  },
  review(e) {
    if (this.data.busy) return
    const id = e.currentTarget.dataset.id,
      status = e.currentTarget.dataset.status,
      note = this.data.notes[id] || ''
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
          await api.request('/api/admin/experiences/' + id + '/review', 'POST', { status, note })
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
