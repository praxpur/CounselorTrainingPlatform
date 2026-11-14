const { encodePassword } = require('./auth')
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
function validateRows(rows, allowAdmins = false) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) fail(400, '名单须包含 1—500 人')
  const seen = new Set()
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') fail(400, '名单第 ' + (index + 1) + ' 行格式错误')
    const { id, name, department, initialPassword } = row, role = row.role || 'counselor'
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 50 ||
      typeof department !== 'string' || !department.trim() || department.length > 100 ||
      typeof initialPassword !== 'string' || initialPassword.length < 12 || initialPassword.length > 128 ||
      !['admin', 'counselor'].includes(role) || (role === 'admin' && !allowAdmins))
      fail(400, '名单第 ' + (index + 1) + ' 行工号、姓名、部门、角色或初始密码无效（密码须为 12—128 位）')
    if (seen.has(id)) fail(400, '名单包含重复工号：' + id)
    seen.add(id)
    return { id, name: name.trim(), department: department.trim(), initialPassword, role }
  })
}
function checkExisting(db, row) {
  const user = db.prepare('SELECT id,name,department,role,enabled FROM users WHERE id=?').get(row.id)
  if (!user) return null
  const credential = db.prepare('SELECT user_id FROM credentials WHERE user_id=?').get(row.id)
  if (credential || !user.enabled || user.name !== row.name || user.department !== row.department || user.role !== row.role)
    fail(409, '工号已存在且无法导入：' + row.id + '；已有密码请使用重置功能')
  return user
}
async function importRoster(db, input, { allowAdmins = false, authorize = () => {} } = {}) {
  const rows = validateRows(input, allowAdmins)
  for (const row of rows) checkExisting(db, row)
  const encoded = []
  for (const row of rows) encoded.push(await encodePassword(row.initialPassword))
  authorize()
  db.exec('BEGIN IMMEDIATE')
  try {
    // 哈希期间可能有其他管理员导入，事务内重新验证整批。
    for (const row of rows) checkExisting(db, row)
    rows.forEach((row, i) => {
      if (!db.prepare('SELECT id FROM users WHERE id=?').get(row.id))
        db.prepare('INSERT INTO users(id,name,department,role) VALUES(?,?,?,?)').run(row.id, row.name, row.department, row.role)
      db.prepare('INSERT INTO credentials VALUES(?,?,1)').run(row.id, encoded[i])
    })
    db.exec('COMMIT')
    return { imported: rows.length }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
async function resetPassword(db, id, password, authorize = () => {}) {
  const encoded = await encodePassword(password)
  authorize()
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(id)) fail(404, '用户不存在')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO credentials VALUES(?,?,1)
      ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,must_change=1`).run(id, encoded)
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
module.exports = { importRoster, resetPassword, validateRows }
