const api = require('../../utils/store')

Page({
  data: {
    loading: false,
    errorMessage: '',
    allRecords: [],
    records: [],
    filter: 'all',
    selectedId: null,
    description: '',
    busy: false,
  },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '', records: [], allRecords: [] })
    try {
      const records = (await api.request('/api/my/records')).map((r) => ({
        ...r,
        startsText: api.time(r.startsAt),
        locationText: r.location || '地点待定',
        experienceLabel:
          { pending: '待审核', rejected: '已驳回', approved: '已通过' }[r.experienceStatus] || '',
      }))
      this.setData({ allRecords: records })
      this.applyFilter()
    } catch (error) {
      this.setData({ errorMessage: error.message })
      api.error(error)
    } finally {
      this.setData({ loading: false })
    }
  },
  changeFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.filter, selectedId: null, description: '' })
    this.applyFilter()
  },
  applyFilter() {
    const groups = {
      pending: ['pending', 'unsubmitted'],
      reviewed: ['approved', 'rejected'],
      cancelled: ['cancelled'],
    }
    this.setData({
      records: this.data.allRecords.filter(
        (r) => this.data.filter === 'all' || groups[this.data.filter].includes(r.reviewStatus),
      ),
    })
  },
  open(event) {
    wx.navigateTo({ url: '/pages/course/detail?id=' + event.currentTarget.dataset.id })
  },
  editExperience(event) {
    const record = this.data.allRecords.find((r) => r.id === event.currentTarget.dataset.id)
    if (record) this.setData({ selectedId: record.id, description: record.experience || '' })
  },
  input(event) {
    this.setData({ description: event.detail.value })
  },
  cancel() {
    if (!this.data.busy) this.setData({ selectedId: null, description: '' })
  },
  async submit() {
    if (this.data.busy) return
    if (!this.data.description.trim()) {
      wx.showToast({ title: '请填写培训经历', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      await api.request('/api/experiences', 'POST', {
        activityId: this.data.selectedId,
        description: this.data.description,
      })
      this.setData({ selectedId: null, description: '' })
      await this.load()
      wx.showToast({ title: '已提交审核' })
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
})
