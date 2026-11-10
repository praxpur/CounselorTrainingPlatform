// 兼容旧入口：经历提交已合并到培训记录页。
Page({
  onLoad() {
    wx.switchTab({ url: '/pages/record/record' })
  },
})
