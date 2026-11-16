const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')
Page({
  data: { loading: false, errorMessage: '', activities: [] },
  onShow() {
    this.load()
  },
  load(append = false) {
    return loadList(this, api, {
      path: '/api/admin/activities',
      field: 'activities',
      map: api.format,
      append,
    })
  },
  previous() {
    return this.load({ pageOffset: this.data.previousOffset })
  },
  more() {
    return this.load(true)
  },
  create() {
    wx.navigateTo({
      url: '/pages/activity-publish/activity-publish',
      fail(error) {
        console.error('打开活动发布页失败', error)
        wx.showToast({
          title: '发布页加载失败，请完整重新编译项目',
          icon: 'none',
          duration: 3000,
        })
      },
    })
  },
  edit(event) {
    wx.navigateTo({
      url: '/pages/activity-publish/activity-publish?id=' + event.currentTarget.dataset.id,
    })
  },
  attendees(event) {
    wx.navigateTo({ url: '/pages/attendees/attendees?id=' + event.currentTarget.dataset.id })
  },
  attendanceSettings(event) {
    wx.navigateTo({
      url: '/pages/attendance-manage/attendance-manage?id=' + event.currentTarget.dataset.id,
    })
  },
  cancel(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '取消活动',
      content: '取消后无法恢复，已有报名记录会保留。确定取消？',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await api.request('/api/admin/activities/' + id, 'DELETE')
          this.load()
        } catch (err) {
          api.error(err)
        }
      },
    })
  },
  deleteActivity(event) {
    if (this.data.deleting) return
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '删除活动',
      content: '删除后无法恢复。已有报名或参加记录的活动不能删除，可选择取消活动。确定删除？',
      success: async (result) => {
        if (!result.confirm || this.data.deleting) return
        this.setData({ deleting: true })
        try {
          await api.request('/api/admin/activities/' + id + '/delete', 'POST')
          wx.showToast({ title: '已删除' })
          await this.load()
        } catch (error) {
          api.error(error)
        } finally {
          this.setData({ deleting: false })
        }
      },
    })
  },
})
