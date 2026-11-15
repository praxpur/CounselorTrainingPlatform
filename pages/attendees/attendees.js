const api = require('../../utils/store')
const { pagePath,readPage } = require('../../utils/pagination')
Page({
  data: { loading: false, errorMessage: '', attendees: [], confirming: false, activity: null },
  onLoad(o) {
    this.id = o.id
  },
  onShow() {
    this.load()
  },
  async load(append = false) {
    if (!api.guard()) return
    const explicit=Number.isInteger(append?.pageOffset)&&append.pageOffset>=0?append.pageOffset:null
    append=append===true
    if (append && (this.data.loading || !this.data.hasMore)) return
    const epoch=(this.requestId||0)+1;this.requestId=epoch
    const offset=explicit!==null?explicit:append?this.data.nextOffset:0
    this.setData({loading:true,errorMessage:'',...(append?{}:{attendees:[],hasMore:false})})
    try {
      const [activity,result]=await Promise.all([api.request('/api/activities/'+this.id),api.request(pagePath('/api/admin/activities/'+this.id+'/attendees',offset||0))])
      if(epoch!==this.requestId)return
      const page=readPage(result,'rows',offset||0),incoming=page.rows.map(row=>({...row,registeredText:api.time(row.registeredAt)}))
      const combined=append?[...this.data.attendees,...incoming]:incoming
      const windowed=combined.length>100
      const rows=windowed?incoming:combined,first=windowed||!append?offset:(this.data.displayFrom||1)-1
      this.setData({previousOffset:offset>0?Math.max(0,offset-20):null,windowed:windowed||first>0,displayFrom:rows.length?first+1:0,displayTo:first+rows.length,activity,canConfirm:activity.status==='published'&&activity.startsAt<=Date.now(),attendees:rows,hasMore:page.hasMore,nextOffset:page.nextOffset,total:page.total})
    }catch(error){if(epoch===this.requestId){this.setData({errorMessage:error.message});api.error(error)}}
    finally{if(epoch===this.requestId)this.setData({loading:false})}
  },
  previous(){return this.load({pageOffset:this.data.previousOffset})},
  more(){return this.load(true)},
  confirm(e) {
    if (this.data.confirming || !this.data.canConfirm) return
    this.setData({ confirming: true })
    const userId = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认参加',
      content: '确认该人员已经参加活动？确认后计入活动学时。',
      success: async (r) => {
        if (!r.confirm) {
          this.setData({ confirming: false })
          return
        }
        try {
          await api.request('/api/admin/activities/' + this.id + '/confirm', 'POST', { userId })
          await this.load()
          wx.showToast({ title: '已确认参加' })
        } catch (err) {
          api.error(err)
        } finally {
          this.setData({ confirming: false })
        }
      },
      fail: () => this.setData({ confirming: false }),
    })
  },
})
