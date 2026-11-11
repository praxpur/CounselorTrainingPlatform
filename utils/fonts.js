const coveredGlyphs = new Set(require('../assets/fonts/coverage'))
let loaded = false
let loading = false
let retryAt = 0

// 常用简体字随包加载，生僻姓名按需加载学校后端提供的完整字体。
function ensureFontForText(value, apiBase) {
  if (loaded || loading || Date.now() < retryAt || typeof wx.loadFontFace !== 'function') return
  const text = JSON.stringify(value) || ''
  const hasRareCjk = [...text].some((char) => {
    const code = char.codePointAt(0)
    return (
      ((code >= 0x3400 && code <= 0x9fff) || (code >= 0x20000 && code <= 0x3134f)) &&
      !coveredGlyphs.has(char)
    )
  })
  if (!hasRareCjk) return
  loading = true
  const failed = (error) => {
    loading = false
    retryAt = Date.now() + 30000
    console.warn('完整 Noto SC 字体加载失败，将在后续请求中重试', error)
  }
  try {
    wx.loadFontFace({
      family: 'Campus Noto SC Full',
      source: 'url("' + apiBase + '/fonts/noto-sans-sc-full.woff2")',
      global: true,
      success() {
        loaded = true
        loading = false
      },
      fail: failed,
    })
  } catch (error) {
    failed(error)
  }
}

module.exports = { ensureFontForText }
