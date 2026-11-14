const api = require('../../utils/store')
const methods = ['qr', 'location', 'both']
Page({
  data: { loading: false, busy: false, errorMessage: '', sessions: [], records: [],
    phaseIndex: 0, phases: ['签到', '签退'], methodIndex: 0, methods: ['扫码', '定位', '扫码＋定位'],
    duration: '15', radius: '100', latitude: null, longitude: null, placeName: '', qrImage: '', qrExpires: '' },
  onLoad(options) { this.id = options.id },
  onShow() { this.load() },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const report = await api.request('/api/admin/activities/' + this.id + '/attendance')
      this.setData({
        sessions: report.sessions.map(session => ({ ...session, phaseLabel: session.phase === 'in' ? '签到' : '签退', closesText: api.time(session.closesAt) })),
        records: report.records.map(record => ({ ...record, phaseLabel: record.phase === 'in' ? '签到' : '签退', timeText: api.time(record.recordedAt) })),
      })
    } catch (error) { this.setData({ errorMessage: error.message }); api.error(error) }
    finally { this.setData({ loading: false }) }
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  chooseLocation() {
    wx.chooseLocation({
      success: location => this.setData({ latitude: location.latitude, longitude: location.longitude, placeName: location.name || location.address }),
      fail: () => api.error(new Error('未选择地点，请授权定位后重试')),
    })
  },
  async open() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const result = await api.request('/api/admin/activities/' + this.id + '/attendance/' + (Number(this.data.phaseIndex) === 0 ? 'in' : 'out'), 'POST', {
        method: methods[Number(this.data.methodIndex)], durationMinutes: Number(this.data.duration),
        latitude: this.data.latitude, longitude: this.data.longitude, radius: Number(this.data.radius),
      })
      this.removeQr()
      this.setData({ qrImage: '', qrExpires: api.time(result.closesAt) })
      if (result.qrPng) {
        const filePath = wx.env.USER_DATA_PATH + '/attendance-' + this.id + '-' + Date.now() + '.png'
        await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: result.qrPng, encoding: 'base64', success: resolve, fail: reject }))
        this.qrPath = filePath
        this.setData({ qrImage: filePath })
      }
      await this.load()
    } catch (error) { api.error(error) }
    finally { this.setData({ busy: false }) }
  },
  async close(event) {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await api.request('/api/admin/activities/' + this.id + '/attendance/' + event.currentTarget.dataset.phase, 'DELETE')
      this.removeQr()
      this.setData({ qrImage: '', qrExpires: '' })
      await this.load()
    } catch (error) { api.error(error) }
    finally { this.setData({ busy: false }) }
  },
  removeQr() {
    if (this.qrPath) wx.getFileSystemManager().unlink({ filePath: this.qrPath, fail() {} })
    this.qrPath = null
  },
  onUnload() { this.removeQr() },
})
