const api = require('../../utils/store')
// 与服务器使用相同的球面距离公式；页面结果仅供核对，签到以服务器校验为准。
function distanceMeters(position, session) {
  const radians = (value) => value * Math.PI / 180
  const value = Math.sin(radians(session.latitude - position.latitude) / 2) ** 2 +
    Math.cos(radians(position.latitude)) * Math.cos(radians(session.latitude)) *
    Math.sin(radians(session.longitude - position.longitude) / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, value)))
}
Page({
  data: { loading: false, busy: false, errorMessage: '', sessions: [], records: [], locationInfo: null, locating: false, locationError: '' },
  onLoad(options) {
    this.id = options.id
  },
  onShow() {
    this.load()
  },
  async load() {
    if (!api.guard()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const state = await api.request('/api/activities/' + this.id + '/attendance')
      this.setData({
        sessions: state.sessions.map((session) => ({
          ...session,
          phaseLabel: session.phase === 'in' ? '签到' : '签退',
          methodLabel: { qr: '扫码', location: '定位', both: '扫码＋定位' }[session.method],
          closesText: api.time(session.closesAt),
          done: state.records.some((record) => record.phase === session.phase),
        })),
        records: state.records.map((record) => ({
          ...record,
          phaseLabel: record.phase === 'in' ? '签到' : '签退',
          methodLabel: { qr: '扫码', location: '定位', both: '扫码＋定位' }[record.method] || '未知方式',
          timeText: api.time(record.recordedAt),
        })),
      })
    } catch (error) {
      this.setData({ errorMessage: error.message })
      api.error(error)
    } finally {
      this.setData({ loading: false })
    }
  },
  async attend(event) {
    const phase = event.currentTarget.dataset.phase
    const session = this.data.sessions.find((value) => value.phase === phase)
    if (this.data.busy || !session?.active || session.done) return
    this.setData({ busy: true })
    try {
      const input = {}
      if (session.method !== 'location') {
        const scan = await new Promise((resolve, reject) =>
          wx.scanCode({
            onlyFromCamera: true,
            scanType: ['qrCode'],
            success: resolve,
            fail: () => reject(new Error('未完成扫码，请重试')),
          }),
        )
        input.qrText = scan.result
      }
      if (session.method !== 'qr') {
        const position = await this.locate(session)
        input.latitude = position.latitude
        input.longitude = position.longitude
        input.accuracy = position.accuracy
      }
      await api.request('/api/activities/' + this.id + '/attendance/' + phase, 'POST', input)
      wx.showToast({ title: session.method === 'qr' ? (phase === 'in' ? '签到成功' : '签退成功') : '定位验证成功' })
      await this.load()
    } catch (error) {
      api.error(error)
      await this.load()
    } finally {
      this.setData({ busy: false })
    }
  },
  async locate(session) {
    this.setData({ locating: true, locationInfo: null, locationError: '' })
    try {
      const position = await new Promise((resolve, reject) => wx.getLocation({
        type: 'gcj02',
        isHighAccuracy: true,
        success: resolve,
        fail: () => reject(new Error('未获取定位，请检查微信位置权限和手机定位开关')),
      }))
      const distance = distanceMeters(position, session)
      this.setData({ locationInfo: {
        latitude: position.latitude,
        longitude: position.longitude,
        latitudeText: position.latitude.toFixed(6),
        longitudeText: position.longitude.toFixed(6),
        centerLatitude: session.latitude,
        centerLongitude: session.longitude,
        distance: Math.round(distance),
        radius: session.radius,
        accuracy: Math.round(position.accuracy),
        inRange: distance <= session.radius,
        accurate: position.accuracy <= session.radius,
        timeText: api.time(Date.now()),
      } })
      return position
    } catch (error) {
      this.setData({ locationError: error.message })
      throw error
    } finally {
      this.setData({ locating: false })
    }
  },
  async checkLocation(event) {
    if (this.data.busy || this.data.locating) return
    const session = this.data.sessions.find((item) => item.phase === event.currentTarget.dataset.phase)
    if (!session || session.method === 'qr') return
    try { await this.locate(session) } catch (error) { api.error(error) }
  },
  showLocation() {
    const position = this.data.locationInfo
    if (!position) return
    wx.openLocation({
      latitude: position.latitude,
      longitude: position.longitude,
      name: '本次获取的当前位置',
      scale: 17,
      fail: () => api.error(new Error('无法打开地图，请检查地图权限')),
    })
  },
})
