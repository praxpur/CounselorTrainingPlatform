const path = require('node:path')
function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
function validateProduction(environment = process.env, runtime = process.versions.node, sqlite = require('node:sqlite')) {
  const [major, minor] = runtime.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 16) || typeof sqlite.backup !== 'function') throw new Error('需要支持 node:sqlite backup 的 Node.js 22.16.0 或更高版本')
  if (environment.NODE_ENV !== 'production') throw new Error('正式服务必须设置 NODE_ENV=production')
  if (environment.ENABLE_DEV_LOGIN && environment.ENABLE_DEV_LOGIN !== '0') throw new Error('正式服务不得启用 ENABLE_DEV_LOGIN')
  if ((environment.HOST || '127.0.0.1') !== '127.0.0.1') throw new Error('正式模板仅允许后端监听 127.0.0.1，由 Nginx 提供 HTTPS')
  const port = Number(environment.PORT || 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效')
  const codeRoot = path.resolve(__dirname, '..')
  for (const key of ['DB_PATH', 'UPLOAD_DIR', 'BACKUP_DIR']) {
    const value = environment[key]
    if (!value || !path.isAbsolute(value) || value === ':memory:') throw new Error(key + ' 必须为绝对持久路径')
    const resolved = path.resolve(value)
    if (inside(codeRoot, resolved) || resolved === path.parse(resolved).root) throw new Error(key + ' 必须位于代码目录外的私有数据位置')
  }
  return { valid: true }
}
if (require.main === module) {
  try { validateProduction(); console.log('生产运行时与配置预检通过') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { validateProduction }
