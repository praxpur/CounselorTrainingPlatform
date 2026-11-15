const api = require('../../../utils/store')
const { loadList,cancelList } = require('../../../utils/pagination')
const years=Array.from({length:101},(_,index)=>2000+index)
const currentYear=new Date(Date.now()+28800000).getUTCFullYear()
Page({
  data: {
    loading: false,
    errorMessage: '',
    people: [],
    visiblePeople: [],
    query: '',
    selected: null,
    records: [],
    years, exportYear:currentYear, yearIndex:currentYear-2000,
  },
  onShow() {
    this.load()
  },
  load(append = false) {
    return loadList(this,api,{ path:'/api/admin/people?q='+encodeURIComponent(this.data.query),field:'people',append,
      after:(_result,rows)=>({ visiblePeople:rows }) })
  },
  more() { return this.load(true) },
  select(event) {
    const id=event.currentTarget.dataset.id
    this.selectedId=id
    return this.loadRecords()
  },
  loadRecords(append=false){
    const id=this.selectedId
    return loadList(this,api,{ path:'/api/admin/person-records?id='+encodeURIComponent(id),field:'records',prefix:'record',append,
      start:{ selected:this.data.people.find(person=>person.id===id)||this.data.selected },map:record=>({ ...record,startsText:api.time(record.startsAt),locationText:record.location||'地点待定' }) })
  },
  previous(){return this.load({pageOffset:this.data.previousOffset})},
  moreRecords(){return this.loadRecords(true)},
  previousRecords(){return this.loadRecords({pageOffset:this.data.recordPreviousOffset})},
  search(event) {
    cancelList(this,'people')
    this.setData({ query:event.detail.value,people:[],visiblePeople:[],hasMore:false,loading:true })
    clearTimeout(this.searchTimer)
    this.searchTimer=setTimeout(()=>this.load(),250)
  },
  changeYear(event) {
    const yearIndex=Number(event.detail.value)
    this.setData({ yearIndex,exportYear:years[yearIndex] })
  },
  onUnload() { clearTimeout(this.searchTimer);cancelList(this,'people');cancelList(this,'records') },
  async exportData() {
    if (this.data.exporting) return
    this.setData({ exporting: true })
    try {
      await api.exportExcel('/api/admin/exports/people?year='+this.data.exportYear+(this.data.selected?'&id='+encodeURIComponent(this.data.selected.id):'&q='+encodeURIComponent(this.data.query)), this.data.exportYear+'-人员报名情况.xlsx')
    } catch (error) {
      api.error(error)
    } finally {
      this.setData({ exporting: false })
    }
  },
  back() {
    cancelList(this,'records')
    this.setData({ selected:null,records:[],loading:false,recordHasMore:false })
  },
})
