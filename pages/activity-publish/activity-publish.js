const api = require('../../utils/store')

function splitDateTime(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
    pad(date.getHours()) + ':' + pad(date.getMinutes()),
  ]
}

Page({
  data: {
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
      creditMinutes: '',
    },
  },
  async onLoad(options) {
    if (!api.guard()) return
    try {
      const user = await api.request('/api/me')
      if (user.role !== 'admin') throw new Error('无管理员权限')
      if (!options.id) return
      const activity = await api.request('/api/activities/' + options.id)
      const [startDate, startTime] = splitDateTime(activity.startsAt)
      const [endDate, endTime] = splitDateTime(activity.endsAt)
      this.setData({
        editing: activity.id,
        form: {
          title: activity.title,
          description: activity.description,
          location: activity.location,
          startDate,
          startTime,
          endDate,
          endTime,
          capacity: String(activity.capacity),
          creditMinutes: String(activity.creditMinutes),
        },
      })
    } catch (error) {
      api.error(error)
      wx.navigateBack()
    }
  },
  input(event) {
    this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value })
  },
  reset() {
    if (!this.data.busy) wx.navigateBack()
  },
  async save() {
    if (this.data.busy) return
    const form = this.data.form
    if (
      !form.title.trim() ||
      !form.location.trim() ||
      !form.startDate ||
      !form.startTime ||
      !form.endDate ||
      !form.endTime ||
      form.creditMinutes === '' ||
      form.capacity === ''
    ) {
      wx.showToast({ title: '请完整填写活动信息', icon: 'none' })
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
          capacity: Number(form.capacity),
          creditMinutes: Number(form.creditMinutes),
        },
      )
      wx.navigateBack({
        success: () => wx.showToast({ title: this.data.editing ? '修改成功' : '发布成功' }),
      })
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
})
