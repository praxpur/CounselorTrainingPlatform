const api = require('../../utils/store')
const { loadList } = require('../../utils/pagination')
const methods = ['qr', 'location', 'both']
const methodLabels = { qr: '扫码', location: '定位', both: '扫码＋定位' }
Page({
  data: {
    loading: false,
    busy: false,
    errorMessage: '',
    sessions: [],
    records: [],
    phaseIndex: 0,
    phases: ['签到', '签退'],
    methodIndex: 0,
    methods: ['扫码', '定位', '扫码＋定位'],
    duration: '15',
    radius: '100',
    latitude: null,
    longitude: null,
    placeName: '',
    qrImage: '',
    qrExpires: '',
    qrPhase: '',
  },
  onLoad(options) {
    this.id = options.id
  },
  onShow() {
    this.load()
  },
  load(append = false) {
    return loadList(this, api, {
      path: '/api/admin/activities/' + this.id + '/attendance',
      field: 'records',
      rowsKey: 'records',
      append,
      map: (record) => ({
        ...record,
        phaseLabel: record.phase === 'in' ? '签到' : '签退',
        timeText: api.time(record.recordedAt),
      }),
      after: (report) => {
        const sessions = report.sessions.map((session) => ({
          ...session,
          phaseLabel: session.phase === 'in' ? '签到' : '签退',
          methodLabel: methodLabels[session.method] || '未知方式',
          closesText: api.time(session.closesAt),
        }))
        const settings = this.settingsLoaded ? {} : this.settingsForPhase(sessions, this.data.phaseIndex)
        this.settingsLoaded = true
        return { sessions, ...settings }
      },
    })
  },
  previous() {
    return this.load({ pageOffset: this.data.previousOffset })
  },
  more() {
    return this.load(true)
  },
  input(event) {
    const field = event.currentTarget.dataset.field
    if (field === 'phaseIndex') {
      const phaseIndex = Number(event.detail.value)
      this.setData({ phaseIndex, ...this.settingsForPhase(this.data.sessions, phaseIndex) })
      return
    }
    this.setData({ [field]: event.detail.value })
  },
  settingsForPhase(sessions, phaseIndex) {
    const phase = Number(phaseIndex) === 0 ? 'in' : 'out'
    const session = sessions.find((item) => item.phase === phase)
    if (!session) return { methodIndex: 0, duration: '15', radius: '100', latitude: null, longitude: null, placeName: '' }
    const methodIndex = methods.indexOf(session.method)
    const hasLocation = session.latitude != null && session.longitude != null
    return {
      methodIndex: methodIndex < 0 ? 0 : methodIndex,
      duration: String(Math.max(1, Math.min(240, Math.round((session.closesAt - session.opensAt) / 60000)))),
      radius: String(session.radius ?? 100),
      latitude: session.latitude ?? null,
      longitude: session.longitude ?? null,
      placeName: hasLocation ? `已保存位置（${session.latitude}, ${session.longitude}）` : '',
    }
  },
  chooseLocation() {
    wx.chooseLocation({
      success: (location) =>
        this.setData({
          latitude: location.latitude,
          longitude: location.longitude,
          placeName: location.name || location.address,
        }),
      fail: () => api.error(new Error('未选择地点，请授权定位后重试')),
    })
  },
  async open() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const result = await api.request(
        '/api/admin/activities/' +
          this.id +
          '/attendance/' +
          (Number(this.data.phaseIndex) === 0 ? 'in' : 'out'),
        'POST',
        {
          method: methods[Number(this.data.methodIndex)],
          durationMinutes: Number(this.data.duration),
          latitude: this.data.latitude,
          longitude: this.data.longitude,
          radius: Number(this.data.radius),
        },
      )
      this.removeQr()
      this.setData({
        qrImage: '',
        qrExpires: api.time(result.closesAt),
        qrPhase: result.phase || (Number(this.data.phaseIndex) === 0 ? 'in' : 'out'),
      })
      if (result.qrPng) {
        const filePath =
          wx.env.USER_DATA_PATH + '/attendance-' + this.id + '-' + Date.now() + '.png'
        await new Promise((resolve, reject) =>
          wx.getFileSystemManager().writeFile({
            filePath,
            data: result.qrPng,
            encoding: 'base64',
            success: resolve,
            fail: reject,
          }),
        )
        this.qrPath = filePath
        this.setData({ qrImage: filePath })
      }
      await this.load()
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
  async close(event) {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await api.request(
        '/api/admin/activities/' + this.id + '/attendance/' + event.currentTarget.dataset.phase,
        'DELETE',
      )
      if (this.data.qrPhase === event.currentTarget.dataset.phase) {
        this.removeQr()
        this.setData({ qrImage: '', qrExpires: '', qrPhase: '' })
      }
      await this.load()
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ busy: false })
    }
  },
  removeQr() {
    if (this.qrPath) wx.getFileSystemManager().unlink({ filePath: this.qrPath, fail() {} })
    this.qrPath = null
  },
  onUnload() {
    this.removeQr()
  },
})
