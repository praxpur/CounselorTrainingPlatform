// 开发工具中使用本机地址；真机和正式部署需要配置学校 HTTPS 域名。
const API_BASE = 'http://127.0.0.1:3000'
const { ensureFontForText } = require('./fonts')
const TOKEN_KEY = 'training_token_v2'
function request(path, method, data) {
  return new Promise((resolve, reject) =>
    wx.request({
      url: API_BASE + path,
      method: method || 'GET',
      timeout: 15000,
      data,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            ensureFontForText(res.data, API_BASE)
          } catch (error) {
            console.warn('字体加载暂不可用', error)
          }
          resolve(res.data)
        } else {
          if (res.statusCode === 401) wx.removeStorageSync(TOKEN_KEY)
          const error = new Error((res.data && res.data.error) || '请求失败')
          error.code = res.data && res.data.code
          error.statusCode = res.statusCode
          reject(error)
        }
      },
      fail(result) {
        reject(
          new Error(
            (result.errMsg || '').includes('timeout')
              ? '请求超时，请稍后重试'
              : '无法连接服务器，请检查网络和服务器配置',
          ),
        )
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
  if (e.code === 'PASSWORD_CHANGE_REQUIRED') {
    wx.reLaunch({ url: '/pages/password/password' })
    return
  }
  if (!wx.getStorageSync(TOKEN_KEY)) wx.reLaunch({ url: '/pages/login/login' })
}
function time(value) {
  if (!Number.isFinite(value)) return ''
  const d = new Date(value + 8 * 3600000),
    p = (n) => String(n).padStart(2, '0')
  return (
    d.getUTCFullYear() +
    '-' +
    p(d.getUTCMonth() + 1) +
    '-' +
    p(d.getUTCDate()) +
    ' ' +
    p(d.getUTCHours()) +
    ':' +
    p(d.getUTCMinutes())
  )
}
function format(a) {
  const now = Date.now()
  const registrationText =
    a.status === 'cancelled'
      ? '活动已取消'
      : a.registered
        ? '已报名'
        : a.endsAt <= now
          ? '活动已结束'
          : a.startsAt <= now
            ? '报名已截止'
            : a.capacity !== null && a.registeredCount >= a.capacity
              ? '名额已满'
              : '报名开放中'
  return {
    ...a,
    startsText: time(a.startsAt),
    endsText: time(a.endsAt),
    capacityText: a.capacity === null ? '不限人数' : String(a.capacity),
    locationText: a.location || '地点待定',
    confirmedText: a.confirmedAt ? time(a.confirmedAt) : '',
    registrationText,
    activityState: a.endsAt <= now ? '已结束' : a.startsAt <= now ? '进行中' : '未开始',
    canRegister:
      a.status === 'published' &&
      !a.registered &&
      a.startsAt > Date.now() &&
      (a.capacity === null || a.registeredCount < a.capacity),
  }
}
// 下载携带登录凭证的 Excel，并通过微信文档预览菜单保存或分享。
function exportExcel(path, filename) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE + path,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      timeout: 60000,
      success(result) {
        if (result.statusCode !== 200) {
          if (result.statusCode === 401) wx.removeStorageSync(TOKEN_KEY)
          reject(
            new Error(result.statusCode === 403 ? '无导出权限' : '导出失败，请重新登录或稍后重试'),
          )
          return
        }
        wx.openDocument({
          filePath: result.tempFilePath || result.filePath,
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
