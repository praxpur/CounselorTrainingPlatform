// 业务变更通过 SQLite 触发器生成通知，保证业务回滚时通知也一起回滚。
const { pageQuery } = require('./pagination')

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status })
}
const nowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)"

function createNotifications(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),
    event_id INTEGER NOT NULL REFERENCES notification_events(id),kind TEXT NOT NULL,
    title TEXT NOT NULL,body TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,
    created_at INTEGER NOT NULL,read_at INTEGER,UNIQUE(user_id,event_id));
    CREATE INDEX IF NOT EXISTS notification_owner ON notifications(user_id,id DESC);
    CREATE INDEX IF NOT EXISTS notification_unread ON notifications(user_id,read_at,id DESC);`)

  const hasCancellation = db
    .prepare('PRAGMA table_info(registrations)')
    .all()
    .some((column) => column.name === 'cancelled_at')
  const active = hasCancellation ? 'r.cancelled_at IS NULL' : '1=1'
  const triggers = []
  function trigger(
    name,
    operation,
    table,
    when,
    kind,
    target,
    recipients,
    title,
    body,
    targetType,
    targetId,
  ) {
    triggers.push(`CREATE TRIGGER notify_${name} AFTER ${operation} ON ${table}${when ? ' WHEN ' + when : ''}
      BEGIN
        INSERT INTO notification_events(kind,target,created_at) VALUES('${kind}',CAST(${target} AS TEXT),${nowSql});
        INSERT INTO notifications(user_id,event_id,kind,title,body,target_type,target_id,created_at)
        SELECT recipient.id,(SELECT MAX(id) FROM notification_events),'${kind}',${title},${body},'${targetType}',${targetId},${nowSql}
        FROM (${recipients}) recipient;
      END;`)
  }
  const counselors = "SELECT id FROM users WHERE enabled=1 AND role='counselor'"
  const admins = "SELECT id FROM users WHERE enabled=1 AND role='admin'"
  const own = (expression) => 'SELECT id FROM users WHERE id=' + expression
  const registered =
    'SELECT u.id FROM users u JOIN registrations r ON r.user_id=u.id WHERE u.enabled=1 AND r.activity_id=NEW.id'
  const activityTitle = 'substr(NEW.title,1,100)'
  trigger(
    'activity_publish',
    'INSERT',
    'activities',
    "NEW.status='published'",
    'activity.published',
    'NEW.id',
    counselors,
    "'新培训活动已发布'",
    "'《'||" + activityTitle + "||'》已发布，请查看活动详情并按需报名。'",
    'activity',
    'NEW.id',
  )
  const changed = [
    'title',
    'description',
    'location',
    'starts_at',
    'ends_at',
    'capacity',
    'credit_hours',
  ]
    .map((field) => 'OLD.' + field + ' IS NOT NEW.' + field)
    .join(' OR ')
  trigger(
    'activity_change',
    'UPDATE',
    'activities',
    "OLD.status='published' AND NEW.status='published' AND (" + changed + ')',
    'activity.changed',
    'NEW.id',
    registered + ' AND ' + active,
    "'已报名活动有调整'",
    "'《'||" + activityTitle + "||'》的活动安排已调整，请查看最新信息。'",
    'activity',
    'NEW.id',
  )
  trigger(
    'activity_cancel',
    'UPDATE',
    'activities',
    "OLD.status IS NOT NEW.status AND NEW.status='cancelled'",
    'activity.cancelled',
    'NEW.id',
    registered,
    "'活动已取消'",
    "'《'||" + activityTitle + "||'》已取消，历史记录保留，该活动不计入学时。'",
    'activity',
    'NEW.id',
  )

  trigger(
    'registration_create',
    'INSERT',
    'registrations',
    hasCancellation ? 'NEW.cancelled_at IS NULL' : '',
    'registration.registered',
    "NEW.activity_id||':'||NEW.user_id",
    own('NEW.user_id'),
    "'报名成功'",
    "'您已报名《'||(SELECT substr(title,1,100) FROM activities WHERE id=NEW.activity_id)||'》，请按时参加。'",
    'activity',
    'NEW.activity_id',
  )
  if (hasCancellation) {
    trigger(
      'registration_cancel',
      'UPDATE',
      'registrations',
      'OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL',
      'registration.cancelled',
      "NEW.activity_id||':'||NEW.user_id",
      own('NEW.user_id'),
      "'已取消报名'",
      "'您已取消《'||(SELECT substr(title,1,100) FROM activities WHERE id=NEW.activity_id)||'》的报名，名额已释放，历史记录保留。'",
      'records',
      'NEW.activity_id',
    )
    trigger(
      'registration_restore',
      'UPDATE',
      'registrations',
      'OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NULL',
      'registration.registered',
      "NEW.activity_id||':'||NEW.user_id",
      own('NEW.user_id'),
      "'重新报名成功'",
      "'您已重新报名《'||(SELECT substr(title,1,100) FROM activities WHERE id=NEW.activity_id)||'》。'",
      'activity',
      'NEW.activity_id',
    )
  }
  // 有待审经历时，确认操作会同步批准经历，统一由经历结果发一次通知。
  trigger(
    'registration_confirm',
    'UPDATE',
    'registrations',
    'OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL' +
      (hasCancellation ? ' AND NEW.cancelled_at IS NULL' : '') +
      " AND NOT EXISTS(SELECT 1 FROM experiences e WHERE e.activity_id=NEW.activity_id AND e.user_id=NEW.user_id AND e.status='pending')",
    'participation.confirmed',
    "NEW.activity_id||':'||NEW.user_id",
    own('NEW.user_id'),
    "'参加情况已确认'",
    "'《'||(SELECT substr(title,1,100) FROM activities WHERE id=NEW.activity_id)||'》已确认参加，认定 '||NEW.credited_hours||' 学时。'",
    'records',
    'NEW.activity_id',
  )

  trigger(
    'experience_pending',
    'INSERT',
    'experiences',
    "NEW.activity_id IS NOT NULL AND NEW.status='pending'",
    'review.pending',
    "'experience:'||NEW.id",
    admins,
    "'有新的培训经历待审核'",
    "'《'||substr(NEW.title,1,100)||'》已提交培训经历，请及时审核。'",
    'reviews',
    'NULL',
  )
  trigger(
    'experience_review',
    'UPDATE',
    'experiences',
    "NEW.activity_id IS NOT NULL AND OLD.status='pending' AND NEW.status IN ('approved','rejected') AND NEW.reviewed_by IS NOT NULL AND EXISTS(SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND a.status='published')",
    'experience.reviewed',
    "'experience:'||NEW.id",
    own('NEW.user_id'),
    "CASE WHEN NEW.status='approved' THEN '培训经历审核通过' ELSE '培训经历已驳回' END",
    "'《'||substr(NEW.title,1,100)||'》'||CASE WHEN NEW.status='approved' THEN '审核通过，认定 '||NEW.credit_hours||' 学时。' ELSE '未通过审核。' END||CASE WHEN NEW.review_note<>'' THEN '审核意见：'||substr(NEW.review_note,1,500) ELSE '' END",
    'records',
    'NEW.activity_id',
  )

  trigger(
    'external_pending',
    'INSERT',
    'external_trainings',
    "NEW.status='pending'",
    'review.pending',
    "'external:'||NEW.id",
    admins,
    "'有新的自行培训待审核'",
    "'《'||substr(NEW.title,1,100)||'》已提交参加证明，请及时审核。'",
    'reviews',
    'NULL',
  )
  trigger(
    'external_resubmit',
    'UPDATE',
    'external_trainings',
    "OLD.status<>'pending' AND NEW.status='pending'",
    'review.pending',
    "'external:'||NEW.id",
    admins,
    "'自行培训已重新提交'",
    "'《'||substr(NEW.title,1,100)||'》已修改后重新提交，请再次审核。'",
    'reviews',
    'NULL',
  )
  trigger(
    'external_review',
    'UPDATE',
    'external_trainings',
    "OLD.status='pending' AND NEW.status IN ('approved','rejected')",
    'external.reviewed',
    "'external:'||NEW.id",
    own('NEW.user_id'),
    "CASE WHEN NEW.status='approved' THEN '自行培训审核通过' ELSE '自行培训已驳回' END",
    "'《'||substr(NEW.title,1,100)||'》'||CASE WHEN NEW.status='approved' THEN '审核通过，认定 '||NEW.credited_hours||' 学时。' ELSE '未通过审核。' END||CASE WHEN NEW.review_note<>'' THEN '审核意见：'||substr(NEW.review_note,1,500) ELSE '' END",
    'external',
    'NEW.id',
  )

  trigger(
    'credential_initial',
    'INSERT',
    'credentials',
    'NEW.must_change=1',
    'security.account_ready',
    'NEW.user_id',
    own('NEW.user_id'),
    "'账号已开通'",
    "'账号已配置初始密码。首次登录请设置个人密码，密码遗失请联系管理员。'",
    'password',
    'NULL',
  )
  trigger(
    'credential_reset',
    'UPDATE',
    'credentials',
    'NEW.must_change=1 AND (OLD.password_hash IS NOT NEW.password_hash OR OLD.must_change IS NOT NEW.must_change)',
    'security.password_reset',
    'NEW.user_id',
    own('NEW.user_id'),
    "'账号密码已重置'",
    "'管理员已重置您的密码，旧会话已失效。请使用新发放的初始密码登录并修改；如非本人申请，请联系管理员。'",
    'password',
    'NULL',
  )

  // 触发器更新与创建原子完成，避免运维进程重载时出现不发送通知的空窗。
  db.exec('BEGIN IMMEDIATE')
  try {
    const owned = [
      'activity_publish',
      'activity_change',
      'activity_cancel',
      'registration_create',
      'registration_cancel',
      'registration_restore',
      'registration_confirm',
      'experience_pending',
      'experience_review',
      'external_pending',
      'external_resubmit',
      'external_review',
      'credential_initial',
      'credential_reset',
    ]
    for (const name of owned) db.exec('DROP TRIGGER IF EXISTS notify_' + name)
    for (const sql of triggers) db.exec(sql)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  function identity(user) {
    const current =
      user && typeof user.id === 'string'
        ? db.prepare('SELECT id,role FROM users WHERE id=? AND enabled=1').get(user.id)
        : null
    if (!current) fail(401, '请登录')
    return current
  }
  function rowId(id) {
    const value = Number(id)
    if (!Number.isSafeInteger(value) || value <= 0) fail(400, '通知编号无效')
    return value
  }
  function targetFor(row, user) {
    const id = Number(row.target_id)
    if (row.target_type === 'password') return { url: '/pages/password/password', tab: false }
    if (row.target_type === 'reviews')
      return user.role === 'admin' ? { url: '/pages/reviews/reviews', tab: false } : null
    if (row.target_type === 'records')
      return user.role === 'counselor' ? { url: '/pages/record/record', tab: true } : null
    if (!Number.isSafeInteger(id) || id <= 0) return null
    if (row.target_type === 'external') {
      if (
        user.role !== 'counselor' ||
        !db.prepare('SELECT id FROM external_trainings WHERE id=? AND user_id=?').get(id, user.id)
      )
        return null
      return { url: '/pages/self-training/self-training?id=' + id, tab: false }
    }
    if (row.target_type === 'activity') {
      const event = db.prepare('SELECT id,status FROM activities WHERE id=?').get(id)
      if (user.role === 'admin')
        return { url: '/pages/activity-manage/activity-manage', tab: false }
      if (!event) return { url: '/pages/record/record', tab: true }
      const registration = db
        .prepare('SELECT * FROM registrations WHERE activity_id=? AND user_id=?')
        .get(id, user.id)
      if (
        event.status !== 'published' &&
        (!registration || (hasCancellation && registration.cancelled_at !== null))
      )
        return { url: '/pages/record/record', tab: true }
      return { url: '/pages/course/detail?id=' + id, tab: false }
    }
    return null
  }
  function unreadCount(user) {
    const current = identity(user)
    return db
      .prepare('SELECT COUNT(*) unreadCount FROM notifications WHERE user_id=? AND read_at IS NULL')
      .get(current.id).unreadCount
  }
  return {
    unreadCount,
    list(user, url) {
      const current = identity(user),
        query = new URL(url || 'http://localhost/api/notifications')
      const unread = query.searchParams.get('unread')
      if (unread !== null && !['0', '1'].includes(unread)) fail(400, '通知筛选无效')
      if (!query.searchParams.has('limit')) query.searchParams.set('limit', '20')
      const currentMax = db
        .prepare('SELECT COALESCE(MAX(id),0) id FROM notifications WHERE user_id=?')
        .get(current.id).id
      const supplied = query.searchParams.get('snapshot')
      if (
        supplied !== null &&
        (!/^\d{1,16}$/.test(supplied) || !Number.isSafeInteger(Number(supplied)))
      )
        fail(400, '通知快照参数无效')
      const snapshot = supplied === null ? currentMax : Number(supplied)
      const result = pageQuery(
        db,
        'SELECT id,kind,title,body,created_at createdAt,read_at readAt FROM notifications WHERE user_id=? AND id<=?' +
          (unread === '1' ? ' AND read_at IS NULL' : '') +
          ' ORDER BY id DESC',
        [current.id, snapshot],
        query,
      )
      return {
        ...result,
        snapshot,
        hasNewer: currentMax > snapshot,
        unreadCount: unreadCount(current),
      }
    },
    read(user, id) {
      const current = identity(user),
        key = rowId(id)
      const row = db
        .prepare('SELECT * FROM notifications WHERE id=? AND user_id=?')
        .get(key, current.id)
      if (!row) fail(404, '通知不存在')
      const now = Date.now()
      const result = db
        .prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL')
        .run(now, key, current.id)
      return {
        ok: true,
        changed: Boolean(result.changes),
        readAt: row.read_at ?? now,
        target: targetFor(row, current),
        unreadCount: unreadCount(current),
      }
    },
    readAll(user) {
      const current = identity(user)
      const readAt = Date.now()
      const result = db
        .prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL')
        .run(readAt, current.id)
      return { ok: true, updated: result.changes, readAt, unreadCount: 0 }
    },
  }
}
module.exports = { createNotifications }
