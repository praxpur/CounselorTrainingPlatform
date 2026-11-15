// 保留旧页面注册，既有入口转到当前页面。
Page({
  onLoad() {
    wx.redirectTo({
      url: '/pages/stastic/people/people',
      fail() { wx.reLaunch({ url: '/pages/stastic/people/people' }) },
    })
  },
})
