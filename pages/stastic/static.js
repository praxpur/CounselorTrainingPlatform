const api = require('../../utils/store')
const PAGE_SIZE = 20
const years = Array.from({ length: 101 }, (_, index) => 2000 + index)
const currentYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
const tabs = [
  { value: 'activity', label: '按活动', search: '搜索活动名称、主办方或地点' },
  { value: 'counselor', label: '按辅导员', search: '搜索工号、姓名或学院' },
  { value: 'department', label: '按学院', search: '搜索学院 / 部门' },
  { value: 'ranking', label: '年度排行', search: '搜索工号、姓名或学院，保留年度总榜名次' },
]
const emptyTotals = () => ({
  recordCount: 0,
  attendedCount: 0,
  pendingCount: 0,
  rejectedCount: 0,
  cancelledCount: 0,
  totalHours: 0,
})

Page({
  data: {
    authorized: false,
    loading: true,
    errorMessage: '',
    exporting: false,
    canExport: false,
    tabs,
    dimension: 'activity',
    dimensionLabel: '按活动',
    searchPlaceholder: tabs[0].search,
    years,
    year: currentYear,
    yearIndex: currentYear - 2000,
    query: '',
    appliedQuery: '',
    dirty: false,
    selected: null,
    rows: [],
    total: 0,
    totals: emptyTotals(),
    hasMore: false,
    nextOffset: null,
    previousOffset: null,
    displayFrom: 0,
    displayTo: 0,
    windowed: false,
  },
  onLoad(options = {}) {
    const tab = tabs.find((value) => value.value === options.dimension)
    if (tab)
      this.setData({
        dimension: tab.value,
        dimensionLabel: tab.label,
        searchPlaceholder: tab.search,
      })
    const year = Number(options.year)
    if (Number.isInteger(year) && year >= 2000 && year <= 2100)
      this.setData({ year, yearIndex: year - 2000 })
  },
  onShow() {
    this.visible = true
    this.needsRefresh = true
    if (!this.data.exporting) return this.load()
  },
  onHide() {
    this.visible = false
    this.needsRefresh = true
    this.invalidate()
    this.setData({ loading: false, canExport: false })
  },
  onUnload() {
    this.visible = false
    this.needsRefresh = false
    this.invalidate()
  },
  invalidate() {
    this.requestId = (this.requestId || 0) + 1
    this.loadedSignature = null
    return this.requestId
  },
  signature() {
    return JSON.stringify([
      this.data.dimension,
      this.data.year,
      this.data.appliedQuery,
      this.data.selected?.key || '',
    ])
  },
  parameters() {
    const params = 'dimension=' + this.data.dimension + '&year=' + this.data.year
    return this.data.selected
      ? params + '&key=' + encodeURIComponent(this.data.selected.key)
      : params + '&q=' + encodeURIComponent(this.data.appliedQuery)
  },
  async load() {
    if (this.visible === false || this.data.exporting) return
    this.needsRefresh = false
    if (!api.guard()) return
    const epoch = this.invalidate()
    this.setData({ loading: true, errorMessage: '', canExport: false, authorized: false })
    try {
      const user = await api.request('/api/me')
      if (epoch !== this.requestId) return
      if (user.role !== 'admin') throw new Error('无管理员权限')
      this.setData({ authorized: true })
      if (this.data.dirty) {
        this.setData({ loading: false })
        return
      }
      return this.fetchRows()
    } catch (error) {
      if (epoch !== this.requestId) return
      this.setData({ loading: false, errorMessage: error.message, authorized: false })
      api.error(error)
    }
  },
  async fetchRows(append = false, pageOffset = 0) {
    if (
      this.visible === false ||
      !this.data.authorized ||
      !api.guard() ||
      this.data.exporting ||
      this.data.dirty
    )
      return
    if (append && (this.data.loading || !this.data.hasMore)) return
    const offset = append ? this.data.nextOffset : pageOffset
    const signature = this.signature(),
      epoch = this.invalidate()
    const selected = this.data.selected
    this.setData({
      loading: true,
      errorMessage: '',
      canExport: false,
      ...(append
        ? {}
        : {
            rows: [],
            total: 0,
            totals: emptyTotals(),
            hasMore: false,
            nextOffset: null,
            previousOffset: null,
            windowed: false,
            displayFrom: 0,
            displayTo: 0,
          }),
    })
    try {
      const result = await api.request(
        '/api/admin/statistics' +
          (selected ? '/records' : '') +
          '?' +
          this.parameters() +
          '&limit=' +
          PAGE_SIZE +
          '&offset=' +
          (offset || 0),
      )
      if (epoch !== this.requestId || signature !== this.signature()) return
      if (!result || !Array.isArray(result.rows)) throw new Error('统计数据格式错误，请刷新重试')
      const incoming = result.rows.map((row) => ({
        ...row,
        rowKey: String(row.key ?? row.id),
        timeText: api.time(row.startsAt),
        sourceLabel:
          row.sourceLabel || { platform: '平台活动', external: '自行培训' }[row.source] || '',
      }))
      let rows = append ? [...this.data.rows, ...incoming] : incoming
      let first = append ? Math.max(0, this.data.displayFrom - 1) : offset || 0
      const windowed = rows.length > 100 || JSON.stringify(rows).length > 100000
      if (windowed) {
        rows = incoming
        first = offset || 0
      }
      this.loadedSignature = signature
      const totals = { ...emptyTotals(), ...(result.totals || selected || {}) }
      this.setData({
        rows,
        total: result.total ?? incoming.length,
        totals,
        hasMore: Boolean(result.hasMore),
        nextOffset: result.nextOffset ?? null,
        previousOffset: offset > 0 ? Math.max(0, offset - PAGE_SIZE) : null,
        displayFrom: rows.length ? first + 1 : 0,
        displayTo: first + rows.length,
        windowed: windowed || first > 0,
        canExport: true,
      })
    } catch (error) {
      if (epoch === this.requestId) {
        this.setData({ errorMessage: error.message, canExport: false })
        api.error(error)
      }
    } finally {
      if (epoch === this.requestId) this.setData({ loading: false })
    }
  },
  changeDimension(event) {
    if (!this.data.authorized || this.data.exporting) return
    const tab = tabs.find((value) => value.value === event.currentTarget.dataset.dimension)
    if (!tab || tab.value === this.data.dimension) return
    this.invalidate()
    this.setData({
      dimension: tab.value,
      dimensionLabel: tab.label,
      searchPlaceholder: tab.search,
      selected: null,
      query: '',
      appliedQuery: '',
      dirty: false,
      canExport: false,
    })
    return this.fetchRows()
  },
  changeYear(event) {
    if (!this.data.authorized || this.data.exporting) return
    const yearIndex = Number(event.detail.value)
    if (!Number.isInteger(yearIndex) || !years[yearIndex]) return
    this.invalidate()
    this.setData({
      yearIndex,
      year: years[yearIndex],
      selected: null,
      query: this.data.query.trim(),
      appliedQuery: this.data.query.trim(),
      dirty: false,
      canExport: false,
    })
    return this.fetchRows()
  },
  inputQuery(event) {
    if (this.data.exporting) return
    this.invalidate()
    this.setData({ query: event.detail.value, dirty: true, loading: false, canExport: false })
  },
  search() {
    if (!this.data.authorized || this.data.exporting) return
    this.setData({
      appliedQuery: this.data.query.trim(),
      query: this.data.query.trim(),
      selected: null,
      dirty: false,
    })
    return this.fetchRows()
  },
  select(event) {
    if (
      this.data.loading ||
      this.data.exporting ||
      this.data.dirty ||
      this.data.dimension === 'ranking'
    )
      return
    const selected = this.data.rows.find(
      (row) => String(row.key ?? row.id) === String(event.currentTarget.dataset.key),
    )
    if (!selected) return
    this.setData({ selected, canExport: false })
    return this.fetchRows()
  },
  back() {
    if (this.data.exporting) return
    this.invalidate()
    this.setData({ selected: null, canExport: false })
    return this.fetchRows()
  },
  more() {
    return this.fetchRows(true)
  },
  previous() {
    if (this.data.previousOffset === null || this.data.loading) return
    return this.fetchRows(false, this.data.previousOffset)
  },
  async exportData() {
    if (
      !this.data.canExport ||
      this.data.loading ||
      this.data.exporting ||
      this.data.dirty ||
      this.loadedSignature !== this.signature()
    )
      return
    this.setData({ exporting: true })
    try {
      await api.exportExcel(
        '/api/admin/exports/statistics?' + this.parameters(),
        this.data.year +
          '-数据统计与排名-' +
          this.data.dimensionLabel +
          (this.data.selected ? '-明细' : '') +
          '.xlsx',
      )
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ exporting: false })
      if (this.visible && this.needsRefresh) await this.load()
    }
  },
})
