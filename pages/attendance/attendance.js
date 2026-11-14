const api = require('../../utils/store')
Page({
  data: { loading: false, busy: false, errorMessage: '', sessions: [], records: [] },
  onLoad(options) { this.id = options.id },
  onShow() { this.load() },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const state = await api.request('/api/activities/' + this.id + '/attendance')
      this.setData({
        sessions: state.sessions.map(session => ({ ...session,
          phaseLabel: session.phase === 'in' ? '签到' : '签退',
          methodLabel: { qr: '扫码', location: '定位', both: '扫码＋定位' }[session.method],
          closesText: api.time(session.closesAt), done: state.records.some(record => record.phase === session.phase),
        })),
        records: state.records.map(record => ({ ...record, phaseLabel: record.phase === 'in' ? '签到' : '签退', timeText: api.time(record.recordedAt) })),
      })
    } catch (error) { this.setData({ errorMessage: error.message }); api.error(error) }
    finally { this.setData({ loading: false }) }
  },
  async attend(event) {
    const phase = event.currentTarget.dataset.phase
    const session = this.data.sessions.find(value => value.phase === phase)
    if (this.data.busy || !session?.active || session.done) return
    this.setData({ busy: true })
    try {
      const input = {}
      if (session.method !== 'location') {
        const scan = await new Promise((resolve, reject) => wx.scanCode({ onlyFromCamera: true, scanType: ['qrCode'], success: resolve, fail: () => reject(new Error('未完成扫码，请重试')) }))
        input.qrText = scan.result
      }
      if (session.method !== 'qr') {
        const position = await new Promise((resolve, reject) => wx.getLocation({ type: 'gcj02', isHighAccuracy: true, success: resolve, fail: () => reject(new Error('未获取定位，请允许位置权限后在现场重试')) }))
        input.latitude = position.latitude; input.longitude = position.longitude; input.accuracy = position.accuracy
      }
      await api.request('/api/activities/' + this.id + '/attendance/' + phase, 'POST', input)
      wx.showToast({ title: phase === 'in' ? '签到成功' : '签退成功' })
      await this.load()
    } catch (error) { api.error(error); await this.load() }
    finally { this.setData({ busy: false }) }
  },
})
