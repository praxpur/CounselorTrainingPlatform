const api = require('../../utils/store')
const { parseRosterCsv } = require('../../utils/roster')
Page({
  data: { rows: [], busy: false, filename: '', imported: 0, errorMessage: '' },
  onShow() { api.guard() },
  chooseFile() {
    if (this.data.busy) return
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['csv'],
      success: result => {
        const file = result.tempFiles[0]
        this.rows = null
        this.setData({ rows: [], filename: '', imported: 0, errorMessage: '' })
        if (file.size > 256 * 1024) return api.error(new Error('名单文件不能超过 256 KB'))
        wx.getFileSystemManager().readFile({
          filePath: file.path, encoding: 'utf8',
          success: result => {
            try {
              const rows = parseRosterCsv(result.data)
              // 预览只保留身份字段；密码不通过 setData 传给视图层。
              this.rows = rows
              this.setData({ rows: rows.map(({ id, name, department }) => ({ id, name, department })), filename: file.name, imported: 0, errorMessage: '' })
            } catch (error) { api.error(error) }
          },
          fail: () => api.error(new Error('无法读取 CSV 文件')),
        })
      },
    })
  },
  async importRows() {
    if (this.data.busy || !this.rows?.length) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      while (this.data.imported < this.rows.length) {
        if (this.unloaded) return
        const start = this.data.imported
        const result = await api.request('/api/admin/users/import', 'POST', { rows: this.rows.slice(start, start + 10) })
        if (this.unloaded) return
        this.setData({ imported: start + result.imported })
      }
      this.rows = null
      wx.showToast({ title: '名单导入完成' })
    } catch (error) {
      this.setData({ errorMessage: error.message + '；已完成 ' + this.data.imported + ' 人。请核对名单后重新选择文件。' })
      // 网络超时可能已经落库，禁止盲目重复提交当前批。
      this.rows = null
      api.error(error)
    } finally { if (!this.unloaded) this.setData({ busy: false }) }
  },
  onUnload() { this.unloaded = true; this.rows = null },
})
