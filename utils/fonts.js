const coveredGlyphs = new Set(require('../assets/fonts/coverage.json'))
let attemptedFullFont = false

// 常用简体字随包加载，生僻姓名按需加载学校后端提供的完整字体。
function ensureFontForText(value, apiBase) {
  if (attemptedFullFont || typeof wx.loadFontFace !== 'function') return
  const text = JSON.stringify(value) || ''
  const hasRareCjk = [...text].some((char) => {
    const code = char.codePointAt(0)
    return (
      ((code >= 0x3400 && code <= 0x9fff) || (code >= 0x20000 && code <= 0x3134f)) &&
      !coveredGlyphs.has(char)
    )
  })
  if (!hasRareCjk) return
  attemptedFullFont = true
  wx.loadFontFace({
    family: 'Campus Noto SC Full',
    source: 'url("' + apiBase + '/fonts/noto-sans-sc-full.woff2")',
    global: true,
    fail(error) {
      console.warn('完整 Noto SC 字体加载失败，请检查服务器和字体域名配置', error)
    },
  })
}

module.exports = { ensureFontForText }
