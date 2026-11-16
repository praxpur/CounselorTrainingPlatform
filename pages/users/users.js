const api = require('../../utils/store')
const { loadList, cancelList } = require('../../utils/pagination')
const empty = () => ({ id: '', name: '', department: '', initialPassword: '' })
Page({
  data: {
    loading: false,
    errorMessage: '',
    users: [],
    form: empty(),
    editing: false,
    resetting: false,
    query: '',
    appliedQuery: '',
    dirty: false,
    busy: false,
    formVisible: false,
    scrollTarget: '',
  },
  onShow() {
    this.load()
  },
  create() {
    this.showEditor({ editing: false, resetting: false, form: empty(), formVisible: true })
  },
  showEditor(value) {
    this.setData({ ...value, scrollTarget: '' }, () =>
      this.setData({ scrollTarget: 'user-editor' }),
    )
  },
  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },
  searchInput(e) {
    cancelList(this, 'users')
    this.setData({ query: e.detail.value, dirty: true, loading: false })
  },
  search() {
    this.setData({
      query: this.data.query.trim(),
      appliedQuery: this.data.query.trim(),
      dirty: false,
    })
    return this.load()
  },
  load(append = false) {
    if (this.data.dirty) return
    return loadList(this, api, {
      path: '/api/admin/users?q=' + encodeURIComponent(this.data.appliedQuery),
      field: 'users',
      append,
    })
  },
  previous() {
    return this.load({ pageOffset: this.data.previousOffset })
  },
  more() {
    return this.load(true)
  },
  edit(e) {
    const u = this.data.users.find((x) => x.id === e.currentTarget.dataset.id)
    if (u)
      this.showEditor({
        editing: true,
        resetting: false,
        formVisible: true,
        form: { id: u.id, name: u.name, department: u.department, initialPassword: '' },
      })
  },
  reset() {
    this.setData({
      editing: false,
      resetting: false,
      form: empty(),
      formVisible: false,
      scrollTarget: '',
    })
  },
  resetAccount(event) {
    const user = this.data.users.find((value) => value.id === event.currentTarget.dataset.id)
    if (user && !this.data.busy)
      this.showEditor({
        editing: true,
        resetting: true,
        formVisible: true,
        form: {
          id: user.id,
          name: user.name,
          department: user.department,
          initialPassword: '',
        },
      })
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
      if (
        (!this.data.editing || this.data.resetting) &&
        (f.initialPassword.length < 8 || f.initialPassword.length > 128)
      )
        throw new Error('初始密码须为 8—128 位')
      if (this.data.resetting) {
        await api.request('/api/admin/users/' + encodeURIComponent(f.id) + '/password', 'POST', {
          initialPassword: f.initialPassword,
        })
      } else if (this.data.editing) {
        await api.request('/api/admin/users/' + encodeURIComponent(f.id), 'PUT', {
          name: f.name,
          department: f.department,
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
