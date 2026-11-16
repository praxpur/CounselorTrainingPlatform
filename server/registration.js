// 在写事务内检查报名状态和容量，取消报名保留历史记录。
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status })
}

function ensureRegistrationSchema(db) {
  const columns = db.prepare('PRAGMA table_info(registrations)').all()
  if (!columns.some((column) => column.name === 'cancelled_at'))
    db.exec('ALTER TABLE registrations ADD COLUMN cancelled_at INTEGER')
  db.exec(
    'CREATE INDEX IF NOT EXISTS registration_active ON registrations(activity_id,user_id) WHERE cancelled_at IS NULL',
  )
}

function createRegistration(db) {
  // 所有 SQL 文本固定，复用编译结果；不缓存用户提供的 SQL 或记录快照。
  const statements = new Map()
  const statement = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql))
    return statements.get(sql)
  }
  function event(id) {
    if (!Number.isSafeInteger(id) || id <= 0) fail(400, '活动编号无效')
    const value = statement('SELECT id,status,starts_at,capacity FROM activities WHERE id=?').get(
      id,
    )
    if (!value) fail(404, '活动不存在')
    return value
  }
  function own(id, userId) {
    return statement('SELECT * FROM registrations WHERE activity_id=? AND user_id=?').get(
      id,
      userId,
    )
  }
  function open(value) {
    if (value.status !== 'published' || value.starts_at <= Date.now())
      fail(409, '活动已取消或报名已截止')
  }
  function registerCheck(id, userId) {
    const value = event(id),
      previous = own(id, userId)
    open(value)
    if (previous && previous.cancelled_at === null) fail(409, '您已报名')
    if (previous && previous.confirmed_at !== null) fail(409, '该报名已有参加认定，不能重新报名')
    const count = statement(
      'SELECT COUNT(*) n FROM registrations WHERE activity_id=? AND cancelled_at IS NULL',
    ).get(id).n
    if (value.capacity > 0 && count >= value.capacity) fail(409, '报名人数已满')
  }
  return {
    register(id, userId, authorize = () => {}) {
      registerCheck(id, userId)
      db.exec('BEGIN IMMEDIATE')
      try {
        authorize()
        registerCheck(id, userId)
        statement(`INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,?,?)
          ON CONFLICT(activity_id,user_id) DO UPDATE SET registered_at=excluded.registered_at,
          cancelled_at=NULL,confirmed_at=NULL,confirmed_by=NULL,credited_hours=0
          WHERE registrations.cancelled_at IS NOT NULL`).run(id, userId, Date.now())
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    cancel(id, userId, authorize = () => {}) {
      db.exec('BEGIN IMMEDIATE')
      try {
        authorize()
        open(event(id))
        const record = own(id, userId)
        if (!record || record.cancelled_at !== null) fail(409, '当前未报名或已取消报名')
        if (record.confirmed_at !== null) fail(409, '已确认参加，不能取消报名')
        const now = Date.now()
        const result = statement(
          'UPDATE registrations SET cancelled_at=?,credited_hours=0 WHERE activity_id=? AND user_id=? AND cancelled_at IS NULL AND confirmed_at IS NULL',
        ).run(now, id, userId)
        if (!result.changes) fail(409, '报名状态已改变，请刷新后重试')
        statement(
          "UPDATE experiences SET status='rejected',credit_hours=0,review_note='报名已取消',reviewed_by=NULL,reviewed_at=? WHERE activity_id=? AND user_id=? AND status='pending'",
        ).run(now, id, userId)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}
module.exports = { ensureRegistrationSchema, createRegistration }
