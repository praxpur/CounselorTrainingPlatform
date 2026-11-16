const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')

Page({
  data: {
    loading: false,
    errorMessage: '',
    records: [],
    filter: 'all',
  },
  onShow() {
    this.load()
  },
  load(append = false) {
    return loadList(this, api, {
      path: '/api/my/records?filter=' + this.data.filter,
      field: 'records',
      append,
      map: (record) => ({
        ...record,
        startsText: api.time(record.startsAt),
        locationText: record.location || '地点待定',
        experienceLabel:
          { pending: '待审核', rejected: '已驳回', approved: '已通过' }[record.experienceStatus] ||
          '',
      }),
    })
  },
  previous() {
    return this.load({ pageOffset: this.data.previousOffset })
  },
  more() {
    return this.load(true)
  },
  changeFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.filter })
    this.load()
  },
  open(event) {
    const record = this.data.records.find((value) => value.id === event.currentTarget.dataset.id)
    if (record?.external) {
      wx.navigateTo({ url: '/pages/self-training/self-training?id=' + record.externalId })
      return
    }
    wx.navigateTo({ url: '/pages/course/detail?id=' + event.currentTarget.dataset.id })
  },
  editExperience(event) {
    const record = this.data.records.find((item) => item.id === event.currentTarget.dataset.id)
    if (record?.external) this.open(event)
  },
})
