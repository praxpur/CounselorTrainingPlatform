// 删除已下线功能留下的触发器，避免业务写入调用已移除的审计函数。
function removeAuditSchema(db) {
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'audit_*'").all()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const { name } of triggers) db.exec('DROP TRIGGER IF EXISTS "' + name.replace(/"/g, '""') + '"')
    db.exec('DROP TABLE IF EXISTS audit_logs')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

module.exports = { removeAuditSchema }
