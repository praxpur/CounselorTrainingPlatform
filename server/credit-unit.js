// 单位调整仅重命名字段，按学校要求保留原数值，不做分钟/学时换算。
function migrateCreditUnits(db) {
  const columns = [
    ['activities', 'credit_minutes', 'credit_hours'],
    ['registrations', 'credited_minutes', 'credited_hours'],
    ['experiences', 'credit_minutes', 'credit_hours'],
  ]
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [table, oldName, newName] of columns) {
      const names = db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name)
      if (names.includes(oldName)) {
        if (names.includes(newName)) throw new Error('学时字段冲突，请先核对数据库单位：' + table)
        // 标识符完全由上面的固定常量给定，不接收用户输入。
        db.exec('ALTER TABLE ' + table + ' RENAME COLUMN ' + oldName + ' TO ' + newName)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
module.exports = { migrateCreditUnits }
