const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')

Page({
  data: {
    loading: false,
    errorMessage: '',
    records: [],
    filter: 'all',
    selectedId: null,
    description: '',
    busy: false,
    proofs: [],
    uploading: false,
  },
  onShow() {
    if(this.data.selectedId!==null)return
    this.load()
  },
  load(append = false) {
    return loadList(this,api,{ path:'/api/my/records?filter='+this.data.filter,field:'records',append,
      map:record=>({ ...record,startsText:api.time(record.startsAt),locationText:record.location||'地点待定',
        experienceLabel:{ pending:'待审核',rejected:'已驳回',approved:'已通过' }[record.experienceStatus]||'' }) })
  },
  previous(){return this.load({pageOffset:this.data.previousOffset})},
  more() { return this.load(true) },
  changeFilter(event) {
    if (this.data.busy || this.data.uploading) return
    this.setData({ filter: event.currentTarget.dataset.filter, selectedId: null, description: '' })
    this.load()
  },
  open(event) {
    const record = this.data.records.find(value => value.id === event.currentTarget.dataset.id)
    if (record?.external) {
      wx.navigateTo({ url: '/pages/self-training/self-training?id=' + record.externalId })
      return
    }
    wx.navigateTo({ url: '/pages/course/detail?id=' + event.currentTarget.dataset.id })
  },
  editExperience(event) {
    if (this.data.busy || this.data.uploading) return
    const record = this.data.records.find((r) => r.id === event.currentTarget.dataset.id)
    if (record?.external) { this.open(event); return }
    if (record) this.setData({ selectedId: record.id, description: record.experience || '', proofs: record.proofs || [] })
  },
  proofsChanged(event) { this.setData({ proofs: event.detail.files }) },
  uploadState(event) { this.setData({ uploading: event.detail.busy }) },
  input(event) {
    this.setData({ description: event.detail.value })
  },
  cancel() {
    if (!this.data.busy && !this.data.uploading) this.setData({ selectedId: null, description: '', proofs: [] })
  },
  async submit() {
    if (this.data.busy || this.data.uploading) return
    if (!this.data.description.trim()) {
      wx.showToast({ title: '请填写培训经历', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      await api.request('/api/experiences', 'POST', {
        activityId: this.data.selectedId,
        description: this.data.description,
        proofIds: this.data.proofs.map(file => file.id),
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
