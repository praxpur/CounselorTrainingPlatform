// 保留旧链接，统一进入数据统计与排名。
Page({
  onLoad() {
    const url='/pages/stastic/static?dimension='+'counselor'
    wx.redirectTo({url,fail(){wx.reLaunch({url})}})
  },
})
