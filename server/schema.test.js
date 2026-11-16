const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { removeAuditSchema } = require('./schema')

test('移除审计表和触发器后业务及通知仍可写入，重复初始化不影响数据', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE notifications(body TEXT);
      CREATE TABLE audit_logs(detail TEXT);
      INSERT INTO users VALUES('teacher','原姓名');
      CREATE TRIGGER audit_users_update AFTER UPDATE ON users BEGIN SELECT audit_now(); END;
      CREATE TRIGGER notify_users_update AFTER UPDATE ON users BEGIN INSERT INTO notifications VALUES(NEW.name); END;`)
    removeAuditSchema(db)
    removeAuditSchema(db)
    db.exec("UPDATE users SET name='新姓名' WHERE id='teacher'")
    assert.equal(db.prepare('SELECT name FROM users').get().name, '新姓名')
    assert.equal(db.prepare('SELECT body FROM notifications').get().body, '新姓名')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name GLOB 'audit_*'").get().n, 0)
  } finally { db.close() }
})
