// 开发工具中使用本机地址；真机和正式部署需要配置学校 HTTPS 域名。
const API_BASE = 'http://127.0.0.1:3000'
const TOKEN_KEY = 'training_token_v2'
function request(path, method, data) {
  return new Promise((resolve, reject) =>
    wx.request({
      url: API_BASE + path,
      method: method || 'GET',
      data,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data)
        else {
          if (res.statusCode === 401) wx.removeStorageSync(TOKEN_KEY)
          reject(new Error((res.data && res.data.error) || '请求失败'))
        }
      },
      fail() {
        reject(new Error('无法连接服务器，请检查网络和服务器配置'))
      },
    }),
  )
}
function guard() {
  if (!wx.getStorageSync(TOKEN_KEY)) {
    wx.reLaunch({ url: '/pages/login/login' })
    return false
  }
  return true
}
function error(e) {
  wx.showToast({ title: e.message || '操作失败', icon: 'none', duration: 3000 })
  if (!wx.getStorageSync(TOKEN_KEY)) wx.reLaunch({ url: '/pages/login/login' })
}
function time(value) {
  const d = new Date(value),
    p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes())
  )
}
function format(a) {
  return {
    ...a,
    startsText: time(a.startsAt),
    endsText: time(a.endsAt),
    confirmedText: a.confirmedAt ? time(a.confirmedAt) : '',
    canRegister:
      a.status === 'published' &&
      !a.registered &&
      a.startsAt > Date.now() &&
      a.registeredCount < a.capacity,
  }
}
// 下载携带登录凭证的 Excel，并通过微信文档预览菜单保存或分享。
function exportExcel(path, filename) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE + path,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      filePath: wx.env.USER_DATA_PATH + '/' + filename,
      success(result) {
        if (result.statusCode !== 200) {
          if (result.statusCode === 401) wx.removeStorageSync(TOKEN_KEY)
          reject(
            new Error(result.statusCode === 403 ? '无导出权限' : '导出失败，请重新登录或稍后重试'),
          )
          return
        }
        wx.openDocument({
          filePath: result.filePath,
          fileType: 'xlsx',
          showMenu: true,
          success: resolve,
          fail: () => reject(new Error('文件已下载，当前环境无法打开 Excel，请使用真机预览')),
        })
      },
      fail: () => reject(new Error('下载失败，请检查服务器和下载域名配置')),
    })
  })
}
module.exports = {
  request,
  guard,
  error,
  time,
  format,
  exportExcel,
  setToken: (t) => wx.setStorageSync(TOKEN_KEY, t),
  clearToken: () => wx.removeStorageSync(TOKEN_KEY),
}
