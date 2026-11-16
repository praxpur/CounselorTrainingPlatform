const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

function validateApiUrl(value, { dev = false } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('API 地址不是有效 URL')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('API 地址只能包含协议、主机和端口，不得含凭据、路径、查询或片段')
  if (url.protocol === 'https:') {
    if (url.port && url.port !== '443') throw new Error('生产 HTTPS 地址应使用 443 端口')
    return url.origin
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const bytes = host.split('.').map(Number)
  const local =
    host === 'localhost' ||
    host === '::1' ||
    (net.isIP(host) === 4 &&
      (bytes[0] === 127 ||
        bytes[0] === 10 ||
        (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
        (bytes[0] === 192 && bytes[1] === 168))) ||
    (net.isIP(host) === 6 && /^(fc|fd)/i.test(host))
  if (dev && url.protocol === 'http:' && local) return url.origin
  throw new Error('生产 API 必须使用 HTTPS；--dev 仅允许本机或私有内网 HTTP 地址')
}

function replaceApiBase(source, value, options) {
  const target = validateApiUrl(value, options)
  let matches = 0
  const content = source.replace(
    /^const API_BASE = (['"])[^'"\r\n]*\1(\r?)$/gm,
    (_match, _quote, carriage) => {
      matches++
      return "const API_BASE = '" + target + "'" + carriage
    },
  )
  if (matches !== 1) throw new Error('必须存在且仅存在一个独立的 const API_BASE 字符串声明')
  return { content, url: target }
}

async function configure(file, value, options) {
  const source = await fs.readFile(file, 'utf8'),
    result = replaceApiBase(source, value, options)
  const temporary = file + '.configure-' + crypto.randomBytes(6).toString('hex')
  try {
    await fs.writeFile(temporary, result.content, {
      flag: 'wx',
      mode: (await fs.stat(file)).mode,
    })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.unlink(temporary).catch((failure) => {
      if (failure.code !== 'ENOENT') throw failure
    })
    throw error
  }
  return result.url
}

async function main() {
  const args = process.argv.slice(2),
    value = args.shift(),
    options = { dev: false }
  let file = path.resolve(__dirname, '../utils/store.js'),
    customFile = false
  const usage = () => {
    throw new Error('用法：node scripts/configure-api.js <HTTPS地址> [--dev] [--file <目标文件>]')
  }
  if (!value || value.startsWith('--')) usage()
  while (args.length) {
    const argument = args.shift()
    if (argument === '--dev' && !options.dev) options.dev = true
    else if (argument === '--file' && !customFile) {
      file = args.shift()
      customFile = true
      if (!file || file.startsWith('--')) usage()
    } else usage()
  }
  console.log('API_BASE 已配置为 ' + (await configure(path.resolve(file), value, options)))
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
module.exports = { validateApiUrl, replaceApiBase, configure }
