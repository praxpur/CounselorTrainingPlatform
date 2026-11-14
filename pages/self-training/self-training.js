const api = require('../../utils/store')
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10)
Page({
  data: { loading: false, busy: false, uploading: false, errorMessage: '', editing: false, readOnly: false,
    form: { title: '', organizer: '', occurredOn: today(), requestedHours: '', description: '' }, proofs: [], statusLabel: '', reviewNote: '' },
  onLoad(options) { this.id = options.id ? Number(options.id) : null; if (this.id) this.load() },
  onShow() { api.guard() },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const record = await api.request('/api/my/external-trainings/' + this.id)
      this.setData({ editing: true, readOnly: record.status !== 'rejected', proofs: record.proofs,
        form: { title: record.title, organizer: record.organizer, occurredOn: record.occurredOn, requestedHours: String(record.requestedHours), description: record.description },
        statusLabel: { pending: '待审核', approved: '已通过', rejected: '已驳回，可修改后重新提交' }[record.status], reviewNote: record.reviewNote,
      })
    } catch (error) { this.setData({ errorMessage: error.message, readOnly: true }); api.error(error) }
    finally { this.setData({ loading: false }) }
  },
  input(event) { this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value }) },
  proofsChanged(event) { this.setData({ proofs: event.detail.files }) },
  uploadState(event) { this.setData({ uploading: event.detail.busy }) },
  async submit() {
    if (this.data.busy || this.data.uploading || this.data.loading || this.data.readOnly) return
    if (!this.data.proofs.length) return api.error(new Error('请至少上传一份参加证明'))
    this.setData({ busy: true })
    try {
      const result = await api.request('/api/my/external-trainings' + (this.id ? '/' + this.id : ''), this.id ? 'PUT' : 'POST', {
        ...this.data.form, requestedHours: Number(this.data.form.requestedHours), proofIds: this.data.proofs.map(file => file.id),
      })
      this.id = result.id
      await this.load()
      wx.showToast({ title: '已提交审核' })
    } catch (error) { api.error(error) }
    finally { this.setData({ busy: false }) }
  },
})
