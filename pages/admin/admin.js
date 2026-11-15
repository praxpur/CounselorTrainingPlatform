// 保留旧页面注册，既有入口转到当前页面。
Page({
  onLoad() {
    wx.redirectTo({
      url: '/pages/activity-manage/activity-manage',
      fail() { wx.reLaunch({ url: '/pages/activity-manage/activity-manage' }) },
    })
  },
})
