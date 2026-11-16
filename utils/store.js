// 小程序共用的接口访问、登录状态、活动显示格式和材料操作。
// 局域网真机调试地址；切换 Wi-Fi 后需更新 IP，正式部署改为学校 HTTPS 域名。
const API_BASE = 'http://10.29.182.131:3001'
const TOKEN_KEY = 'training_token_v2'
const BEIJING_TIME_OFFSET = 8 * 60 * 60 * 1000

// 发送请求并携带登录凭证；resolve 表示成功，reject 表示失败。
function request(path, method, data, options = {}) {
  const token = wx.getStorageSync(TOKEN_KEY) || ''

  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + path,
      method: method || 'GET',
      timeout: options.timeout || 15000,
      data,
      header: {
        ...options.header,
        Authorization: 'Bearer ' + token,
      },
      success(response) {
        // 收到响应不一定代表业务成功，还要检查 HTTP 状态码。
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data)
          return
        }

        if (response.statusCode === 401) {
          wx.removeStorageSync(TOKEN_KEY)
        }

        const responseData = response.data || {}
        const requestError = new Error(responseData.error || '请求失败')
        requestError.code = responseData.code
        requestError.statusCode = response.statusCode
        reject(requestError)
      },
      fail(result) {
        let message = '无法连接服务器，请检查网络和服务器配置'
        const errorMessage = result.errMsg || ''

        if (errorMessage.includes('timeout')) {
          message = '请求超时，请稍后重试'
        }

        reject(new Error(message))
      },
    })
  })
}

// 只检查本地是否存有登录凭证；凭证是否有效仍由服务器检查。
function guard() {
  if (!wx.getStorageSync(TOKEN_KEY)) {
    wx.reLaunch({ url: '/pages/login/login' })
    return false
  }
  return true
}

// 显示错误提示，并在需要时跳转页面。
function error(requestError) {
  wx.showToast({
    title: requestError.message || '操作失败',
    icon: 'none',
    duration: 3000,
  })

  if (requestError.code === 'PASSWORD_CHANGE_REQUIRED') {
    wx.reLaunch({ url: '/pages/password/password' })
    return
  }
  if (!wx.getStorageSync(TOKEN_KEY)) {
    wx.reLaunch({ url: '/pages/login/login' })
  }
}

// 把数字补成两位，例如 3 变成字符串 '03'。
function padTwoDigits(number) {
  return String(number).padStart(2, '0')
}

// 把毫秒时间戳转换成北京时间文字，例如 '2026-11-16 09:05'。
function time(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return ''
  }

  // 先加上北京时间与 UTC 的 8 小时时差，再使用 UTC 方法读取各部分。
  const date = new Date(timestamp + BEIJING_TIME_OFFSET)
  const year = date.getUTCFullYear()
  const month = padTwoDigits(date.getUTCMonth() + 1)
  const day = padTwoDigits(date.getUTCDate())
  const hour = padTwoDigits(date.getUTCHours())
  const minute = padTwoDigits(date.getUTCMinutes())

  return `${year}-${month}-${day} ${hour}:${minute}`
}

// 按顺序判断，返回第一个符合条件的报名提示。
function getRegistrationText(activity, now) {
  if (activity.status === 'cancelled') {
    return '活动已取消'
  }
  if (activity.withdrawnAt) {
    return '已取消报名'
  }
  if (activity.registered) {
    return '已报名'
  }
  if (activity.endsAt <= now) {
    return '活动已结束'
  }
  if (activity.startsAt <= now) {
    return '报名已截止'
  }
  if (activity.capacity !== null && activity.registeredCount >= activity.capacity) {
    return '名额已满'
  }
  return '报名开放中'
}

// 保留活动原始数据，补充页面需要的文字和按钮状态。
function format(activity) {
  const now = Date.now()
  const registrationText = getRegistrationText(activity, now)

  let capacityText = '不限人数'
  if (activity.capacity !== null) {
    capacityText = String(activity.capacity)
  }

  let confirmedText = ''
  if (activity.confirmedAt) {
    confirmedText = time(activity.confirmedAt)
  }

  let activityState = '未开始'
  if (activity.endsAt <= now) {
    activityState = '已结束'
  } else if (activity.startsAt <= now) {
    activityState = '进行中'
  }

  const canWithdraw =
    activity.status === 'published' &&
    activity.registered &&
    !activity.confirmedAt &&
    activity.startsAt > now

  const hasAvailablePlaces =
    activity.capacity === null || activity.registeredCount < activity.capacity
  const canRegister =
    activity.status === 'published' &&
    !activity.registered &&
    activity.startsAt > Date.now() &&
    hasAvailablePlaces

  return {
    ...activity,
    startsText: time(activity.startsAt),
    endsText: time(activity.endsAt),
    capacityText,
    locationText: activity.location || '地点待定',
    confirmedText,
    registrationText,
    activityState,
    canWithdraw,
    canRegister,
  }
}

// 下载携带登录凭证的 Excel，并通过微信文档预览菜单保存或分享。
function exportExcel(path) {
  const errorMessages = {
    401: '请重新登录',
    403: '无导出权限',
    413: '导出数据过多，请按年份或人员分批导出',
    429: '当前有导出任务，请稍后重试',
    503: '导出资源不足或超时，请缩小范围重试',
  }

  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE + path,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      timeout: 60000,
      success(result) {
        if (result.statusCode !== 200) {
          if (result.statusCode === 401) {
            wx.removeStorageSync(TOKEN_KEY)
          }
          const message = errorMessages[result.statusCode] || '导出失败，请稍后重试'
          reject(new Error(message))
          return
        }
        wx.openDocument({
          filePath: result.tempFilePath || result.filePath,
          fileType: 'xlsx',
          showMenu: true,
          success: resolve,
          fail() {
            reject(new Error('文件已下载，当前环境无法打开 Excel，请使用真机预览'))
          },
        })
      },
      fail() {
        reject(new Error('下载失败，请检查服务器和下载域名配置'))
      },
    })
  })
}

// 先读取本地文件，再把文件内容上传到服务器。
function uploadProof(filePath, name) {
  return new Promise((resolve, reject) => {
    const fileSystem = wx.getFileSystemManager()

    fileSystem.readFile({
      filePath,
      success(result) {
        const options = {
          timeout: 30000,
          header: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(name),
          },
        }

        request('/api/proofs', 'POST', result.data, options).then(resolve, reject)
      },
      fail() {
        reject(new Error('无法读取证明材料'))
      },
    })
  })
}

// 下载证明材料：图片使用图片预览，其他材料按 PDF 打开。
function openProof(file) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE + '/api/proofs/' + encodeURIComponent(file.id),
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      success(result) {
        if (result.statusCode === 401) {
          wx.removeStorageSync(TOKEN_KEY)
        }

        if (result.statusCode !== 200) {
          reject(new Error('材料下载失败或无访问权限'))
          return
        }

        if (file.mimeType.startsWith('image/')) {
          wx.previewImage({
            urls: [result.tempFilePath],
            success: resolve,
            fail: reject,
          })
        } else {
          wx.openDocument({
            filePath: result.tempFilePath,
            fileType: 'pdf',
            showMenu: true,
            success: resolve,
            fail: reject,
          })
        }
      },
      fail() {
        reject(new Error('证明材料下载失败'))
      },
    })
  })
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token)
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY)
}

// 页面通过 require 引入下面这些函数。
module.exports = {
  request,
  guard,
  error,
  time,
  format,
  exportExcel,
  uploadProof,
  openProof,
  setToken,
  clearToken,
}
