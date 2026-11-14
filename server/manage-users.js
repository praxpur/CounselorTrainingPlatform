// 仅供服务器运维人员离线执行；密码从受保护文件读取，不经过命令行参数。
const fs = require('node:fs/promises')
const { parseRosterCsv } = require('../utils/roster')
const { importRoster, resetPassword } = require('./roster')

async function main() {
  const [command, file] = process.argv.slice(2)
  if (!['bootstrap', 'import', 'reset'].includes(command) || !file)
    throw new Error('用法：node manage-users.js bootstrap|import|reset <名单文件路径>')
  const text = await fs.readFile(file, 'utf8')
  const input = file.toLowerCase().endsWith('.csv') ? parseRosterCsv(text) : JSON.parse(text)
  const { db } = require('./server')
  try {
    if (command === 'bootstrap') {
      const count = db.prepare("SELECT COUNT(*) n FROM credentials c JOIN users u ON c.user_id=u.id WHERE u.role='admin'").get().n
      if (count) throw new Error('已有管理员密码，新增管理员请使用 import')
      if (!Array.isArray(input) || input.length !== 1 || input[0].role !== 'admin')
        throw new Error('bootstrap 需要只包含一个 admin 的 JSON 名单')
    }
    if (command === 'reset') {
      if (!input || typeof input.id !== 'string') throw new Error('重置文件须包含 id 与 initialPassword')
      await resetPassword(db, input.id, input.initialPassword)
      console.log('密码已重置，旧会话已撤销，下次登录须修改密码')
    } else {
      const result = await importRoster(db, input, { allowAdmins: true })
      console.log('已导入 ' + result.imported + ' 个账号；初始密码下次登录必须修改')
    }
  } finally { db.close() }
}
if (require.main === module) main().catch(error => {
  // 不输出包含原始文件内容的 JSON 解析错误或数据库细节。
  console.error(error instanceof SyntaxError ? '名单 JSON 格式错误' : error.message)
  process.exitCode = 1
})
