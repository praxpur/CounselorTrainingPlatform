const api = require('../../utils/store')

function splitDateTime(timestamp) {
  const date = new Date(timestamp + 8 * 3600000)
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()),
    pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()),
  ]
}

Page({
  data: {
    loading: true,
    ready: false,
    errorMessage: '',
    editing: null,
    busy: false,
    form: {
      title: '',
      description: '',
      location: '',
      startDate: '',
      startTime: '',
      endDate: '',
      endTime: '',
      capacity: '',
      creditHours: '',
    },
  },
  onLoad(options) {
    this.options = options || {}
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, ready: false, errorMessage: '' })
    try {
      const user = await api.request('/api/me')
      if (user.role !== 'admin') throw new Error('无管理员权限')
      if (!this.options.id) {
        this.setData({ ready: true })
        return
      }
      const activity = await api.request('/api/activities/' + this.options.id)
      const [startDate, startTime] = splitDateTime(activity.startsAt)
      const [endDate, endTime] = splitDateTime(activity.endsAt)
      this.setData({
        editing: activity.id,
        ready: true,
        form: {
          title: activity.title,
          description: activity.description,
          location: activity.location,
          startDate,
          startTime,
          endDate,
          endTime,
          capacity: activity.capacity === null ? '' : String(activity.capacity),
          creditHours: String(activity.creditHours),
        },
      })
    } catch (error) {
      this.setData({ errorMessage: error.message })
      api.error(error)
    } finally {
      this.setData({ loading: false })
    }
  },
  input(event) {
    this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value })
  },
  reset() {
    if (!this.data.busy) wx.navigateBack()
  },
  async save() {
    if (this.data.busy || !this.data.ready || this.saved) return
    const form = this.data.form
    if (
      !form.title.trim() ||
      !form.startDate ||
      !form.startTime ||
      !form.endDate ||
      !form.endTime ||
      form.creditHours === ''
    ) {
      wx.showToast({ title: '请填写标星号的必填项', icon: 'none' })
      return
    }
    const start = Date.parse(form.startDate + 'T' + form.startTime + ':00+08:00')
    const end = Date.parse(form.endDate + 'T' + form.endTime + ':00+08:00')
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      wx.showToast({ title: '结束时间须晚于开始时间', icon: 'none' })
      return
    }
    if (
      !Number.isFinite(Number(form.creditHours)) ||
      Math.abs(Number(form.creditHours) * 100 - Math.round(Number(form.creditHours) * 100)) > 1e-7 ||
      Number(form.creditHours) < 0 ||
      Number(form.creditHours) > 60000
    ) {
      wx.showToast({ title: '学时须为 0—60000，最多两位小数', icon: 'none' })
      return
    }
    if (
      form.capacity.trim() &&
      (!Number.isInteger(Number(form.capacity)) ||
        Number(form.capacity) < 1 ||
        Number(form.capacity) > 100000)
    ) {
      wx.showToast({ title: '人数上限须为 1—100000 的整数', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      await api.request(
        '/api/admin/activities' + (this.data.editing ? '/' + this.data.editing : ''),
        this.data.editing ? 'PUT' : 'POST',
        {
          title: form.title,
          description: form.description,
          location: form.location,
          startsAt: form.startDate + 'T' + form.startTime + ':00+08:00',
          endsAt: form.endDate + 'T' + form.endTime + ':00+08:00',
          capacity: form.capacity.trim() === '' ? null : Number(form.capacity),
          creditHours: Number(form.creditHours),
        },
      )
      this.saved = true
      wx.navigateBack({
        success: () => wx.showToast({ title: this.data.editing ? '修改成功' : '发布成功' }),
        fail: () => wx.redirectTo({ url: '/pages/admin/admin' }),
      })
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
})
