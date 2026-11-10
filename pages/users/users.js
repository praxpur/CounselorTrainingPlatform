const api = require('../../utils/store')
const empty = () => ({ id: '', name: '', department: '' })
Page({
  data: {
    users: [],
    form: empty(),
    editing: false,
    query: '',
    busy: false,
    formVisible: false,
    scrollTarget: '',
  },
  onShow() {
    this.load()
  },
  create() {
    this.setData({ editing: false, form: empty(), formVisible: true, scrollTarget: 'user-editor' })
  },
  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },
  searchInput(e) {
    this.setData({ query: e.detail.value })
  },
  async load() {
    if (!api.guard()) return
    try {
      this.setData({
        users: await api.request('/api/admin/users?q=' + encodeURIComponent(this.data.query)),
      })
    } catch (e) {
      api.error(e)
    }
  },
  edit(e) {
    const u = this.data.users.find((x) => x.id === e.currentTarget.dataset.id)
    if (u)
      this.setData({
        editing: true,
        formVisible: true,
        scrollTarget: 'user-editor',
        form: { id: u.id, name: u.name, department: u.department },
      })
  },
  reset() {
    this.setData({ editing: false, form: empty(), formVisible: false, scrollTarget: '' })
  },
  async save() {
    if (this.data.busy) return
    const f = this.data.form
    if (!f.id.trim() || !f.name.trim() || !f.department.trim()) {
      wx.showToast({ title: '请填写工号、姓名和部门', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      if (this.data.editing) {
        const u = this.data.users.find((x) => x.id === f.id)
        if (!u) throw new Error('请重新选择用户')
        await api.request('/api/admin/users/' + encodeURIComponent(f.id), 'PUT', {
          name: f.name,
          department: f.department,
          enabled: u.enabled,
        })
      } else {
        await api.request('/api/admin/users', 'POST', f)
      }
      this.reset()
      await this.load()
      wx.showToast({ title: '保存成功' })
    } catch (e) {
      api.error(e)
    } finally {
      this.setData({ busy: false })
    }
  },
  toggle(e) {
    const u = this.data.users.find((x) => x.id === e.currentTarget.dataset.id)
    if (!u || this.data.busy) return
    const next = u.enabled ? 0 : 1
    wx.showModal({
      title: next ? '启用用户' : '停用用户',
      content: next ? '确定启用该用户？' : '停用后该用户不能登录，已有报名记录会保留。',
      success: async (r) => {
        if (!r.confirm || this.data.busy) return
        this.setData({ busy: true })
        try {
          await api.request('/api/admin/users/' + encodeURIComponent(u.id), 'PUT', {
            name: u.name,
            department: u.department,
            enabled: next,
          })
          await this.load()
          wx.showToast({ title: next ? '已启用' : '已停用' })
        } catch (err) {
          api.error(err)
        } finally {
          this.setData({ busy: false })
        }
      },
    })
  },
})
