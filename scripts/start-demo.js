const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { configure } = require('./configure-api')
const root = path.resolve(__dirname, '..')
const temporary = path.join(root, 'tmp')
const demoDirectory = path.join(temporary, 'presentation-demo')
const password = 'Demo12345678!'
const accounts = [
  { id: 'admin', name: '演示管理员', department: '演示部门', role: 'admin' },
  { id: 'user', name: '演示辅导员', department: '演示学院', role: 'counselor' },
]
function inside(parent, target) {
  const relative = path.relative(parent, target)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
async function prepareDirectory(directory) {
  directory = path.resolve(directory)
  if (!inside(temporary, directory)) throw new Error('演示数据必须位于项目 tmp 目录内')
  await fs.mkdir(temporary, { recursive: true })
  if ((await fs.lstat(temporary)).isSymbolicLink()) throw new Error('演示 tmp 目录不能是链接')
  await fs.mkdir(directory, { recursive: true })
  if ((await fs.lstat(directory)).isSymbolicLink() || !inside(await fs.realpath(temporary), await fs.realpath(directory)))
    throw new Error('演示数据目录不能链接到其他位置')
  const database = path.join(directory, 'training.db'), marker = path.join(directory, 'demo-only.json')
  let existing
  try { existing = await fs.lstat(database) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('演示数据库不是普通文件')
  let metadata
  try { metadata = JSON.parse(await fs.readFile(marker, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('演示标记无效，不会修改数据库')
  }
  if (metadata && metadata.kind !== 'counselor-local-demo-v1') throw new Error('目录不是本工具创建的演示目录')
  if (existing && !metadata) throw new Error('该目录已有未知数据库，不会重置其中的账号')
  if (!metadata) await fs.writeFile(marker, JSON.stringify({ kind: 'counselor-local-demo-v1' }), { flag: 'wx' })
  return database
}
function ensureDependencies() {
  for (const name of ['exceljs', 'qrcode']) {
    try { require.resolve(name, { paths: [path.join(root, 'server')] }) }
    catch {
      console.log('首次启动：正在安装后端依赖，请等待……')
      const result = process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/c', 'npm ci'], { cwd: path.join(root, 'server'), stdio: 'inherit' })
        : spawnSync('npm', ['ci'], { cwd: path.join(root, 'server'), stdio: 'inherit' })
      if (result.error || result.status !== 0) throw new Error('依赖安装失败，请检查网络后重新双击启动')
      return
    }
  }
}
async function prepareAccounts(db) {
  const { importRoster, resetPassword } = require('../server/roster')
  for (const account of accounts) {
    const existing = db.prepare('SELECT id FROM users WHERE id=?').get(account.id)
    if (!existing) await importRoster(db, [{ ...account, initialPassword: password }], { allowAdmins: true })
    else {
      db.prepare('UPDATE users SET name=?,department=?,role=?,enabled=1 WHERE id=?').run(account.name, account.department, account.role, account.id)
      await resetPassword(db, account.id, password)
    }
    // 仅修改本工具隔离库的两个演示账号，展示时不再停在首次改密页面。
    db.prepare('UPDATE credentials SET must_change=0 WHERE user_id=?').run(account.id)
  }
  db.exec('DELETE FROM auth_limits')
}
async function startDemo({ directory = demoDirectory, port = 3001, apiFile = path.join(root, 'utils/store.js'), quiet = false } = {}) {
  if (require.cache[require.resolve('../server/server')])
    throw new Error('演示必须独立启动，请双击「demo.cmd」，不能复用已加载的后端进程')
  ensureDependencies()
  const database = await prepareDirectory(directory)
  Object.assign(process.env, { DB_PATH: database, UPLOAD_DIR: path.join(directory, 'uploads'), NODE_ENV: 'development',
    ENABLE_DEV_LOGIN: '0', HOST: '127.0.0.1', PORT: String(port) })
  const { server, db } = require('../server/server')
  const close = async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    db.close()
  }
  try {
    // 先占用演示端口，重复双击或端口冲突时不会重置正在使用的账号。
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port }, resolve)
    })
    await prepareAccounts(db)
    const address = 'http://127.0.0.1:' + server.address().port
    await configure(apiFile, address, { dev: true })
    if (!quiet) console.log([
      '', '演示已启动：打开微信开发者工具，点击「编译」后登录。',
      '', '管理员工号：admin', '辅导员工号：user', '两个账号密码：' + password,
      '', '仅本机演示，不需要首次修改密码；再次启动仍使用以上密码。',
      '演示活动和记录会保留，原有数据库和正式账号不受影响。',
      '本窗口保持打开，按 Ctrl+C 停止。', '', '接口：' + address,
    ].join('\n'))
    return { server, db, close, address }
  } catch (error) {
    await close()
    if (error.code === 'EADDRINUSE') throw new Error('3001端口已被占用：如果演示窗口已经打开，保留原窗口即可')
    throw error
  }
}
if (require.main === module) startDemo().then(application => {
  let closing = false
  const stop = () => {
    if (closing) return
    closing = true
    application.close().catch(() => { process.exitCode = 1 })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}).catch(error => { console.error('演示启动失败：' + error.message); process.exitCode = 1 })
module.exports = { startDemo, prepareDirectory, prepareAccounts }
