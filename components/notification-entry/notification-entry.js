const api = require('../../utils/store')
Component({
  options: { styleIsolation: 'apply-shared' },
  data: { unreadCount: 0, available: true },
  lifetimes: {
    attached() {
      this.active = true
      this.refresh()
      this.startTimer()
    },
    detached() {
      this.stop()
    },
  },
  pageLifetimes: {
    show() {
      this.active = true
      this.refresh()
      this.startTimer()
    },
    hide() {
      this.stop()
    },
  },
  methods: {
    startTimer() {
      if (this.timer) clearInterval(this.timer)
      this.timer = setInterval(() => this.refresh(), 30000)
    },
    stop() {
      this.active = false
      this.epoch = (this.epoch || 0) + 1
      this.pending = false
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    },
    async refresh() {
      if (!this.active || this.pending || !api.guard()) return
      const epoch = (this.epoch || 0) + 1
      this.epoch = epoch
      this.pending = true
      try {
        const result = await api.request('/api/notifications/unread-count')
        if (!this.active || this.epoch !== epoch) return
        this.setData({ unreadCount: Number(result.unreadCount) || 0, available: true })
      } catch (error) {
        if (!this.active || this.epoch !== epoch) return
        this.setData({ available: false })
        if (error.statusCode === 401 || error.code === 'PASSWORD_CHANGE_REQUIRED') api.error(error)
      } finally {
        if (this.epoch === epoch) this.pending = false
      }
    },
  },
})
