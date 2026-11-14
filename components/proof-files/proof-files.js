const api = require('../../utils/store')
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { files: { type: Array, value: [] }, editable: { type: Boolean, value: false } },
  data: { uploading: false },
  methods: {
    add() {
      if (this.data.uploading || this.data.files.length >= 5) return
      wx.chooseMessageFile({ count: 5 - this.data.files.length, type: 'file', extension: ['jpg','jpeg','png','pdf'],
        success: async result => {
          this.setData({ uploading: true }); this.triggerEvent('busy', { busy: true })
          const files = [...this.data.files]
          try {
            for (const file of result.tempFiles) {
              if (file.size > 5 * 1024 * 1024) throw new Error('单份材料不能超过 5 MB')
              files.push(await api.uploadProof(file.path, file.name))
              this.triggerEvent('change', { files: [...files] })
            }
          } catch (error) { api.error(error) }
          finally { this.setData({ uploading: false }); this.triggerEvent('busy', { busy: false }) }
        },
      })
    },
    remove(event) {
      if (this.data.uploading) return
      this.triggerEvent('change', { files: this.data.files.filter(file => file.id !== event.currentTarget.dataset.id) })
    },
    async open(event) {
      const file = this.data.files.find(value => value.id === event.currentTarget.dataset.id)
      if (!file) return
      try { await api.openProof(file) } catch (error) { api.error(error) }
    },
  },
})
