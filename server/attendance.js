const crypto = require('node:crypto')
const QRCode = require('qrcode')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
const coordinate = (value, max) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max
function distanceMeters(a, b, c, d) {
  const radians = value => value * Math.PI / 180
  const x = Math.sin(radians(c - a) / 2) ** 2 + Math.cos(radians(a)) * Math.cos(radians(c)) * Math.sin(radians(d - b) / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, x)))
}
function createAttendance(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS attendance_sessions(
    activity_id INTEGER NOT NULL REFERENCES activities(id), phase TEXT NOT NULL CHECK(phase IN ('in','out')),
    method TEXT NOT NULL CHECK(method IN ('qr','location','both')), qr_hash TEXT,
    opens_at INTEGER NOT NULL, closes_at INTEGER NOT NULL, latitude REAL, longitude REAL, radius REAL,
    created_by TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(activity_id,phase));
    CREATE TABLE IF NOT EXISTS attendance_records(
    activity_id INTEGER NOT NULL REFERENCES activities(id), user_id TEXT NOT NULL REFERENCES users(id),
    phase TEXT NOT NULL CHECK(phase IN ('in','out')), method TEXT NOT NULL,
    recorded_at INTEGER NOT NULL, distance REAL, accuracy REAL, PRIMARY KEY(activity_id,user_id,phase));`)
  function activity(id) {
    const result = db.prepare('SELECT id,status,starts_at FROM activities WHERE id=?').get(id)
    if (!result) fail(404, '活动不存在')
    return result
  }
  function sessions(id) {
    const event = activity(id), now = Date.now()
    return db.prepare(`SELECT phase,method,opens_at opensAt,closes_at closesAt,latitude,longitude,radius
      FROM attendance_sessions WHERE activity_id=? ORDER BY phase`).all(id).map(session => ({
      ...session, active: event.status === 'published' && session.opensAt <= now && session.closesAt > now,
    }))
  }
  return {
    state(id, user) {
      return { sessions: sessions(id), records: db.prepare('SELECT phase,method,recorded_at recordedAt,distance,accuracy FROM attendance_records WHERE activity_id=? AND user_id=? ORDER BY recorded_at').all(id, user.id) }
    },
    report(id) {
      return { sessions: sessions(id), records: db.prepare(`SELECT r.user_id userId,u.name,u.department,r.phase,r.method,r.recorded_at recordedAt,r.distance,r.accuracy
        FROM attendance_records r JOIN users u ON r.user_id=u.id WHERE activity_id=? ORDER BY recorded_at DESC`).all(id) }
    },
    async open(id, phase, input, actor, authorize) {
      if (!['in', 'out'].includes(phase)) fail(400, '签到类型错误')
      const event = activity(id)
      if (event.status !== 'published') fail(409, '活动已取消')
      if (phase === 'out' && event.starts_at > Date.now()) fail(409, '活动开始后才可开放签退')
      const { method, durationMinutes = 15, latitude, longitude, radius = 100 } = input
      if (!['qr', 'location', 'both'].includes(method) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240)
        fail(400, '请选择签到方式与 1—240 分钟有效期')
      if (method !== 'qr' && (!coordinate(latitude, 90) || !coordinate(longitude, 180) || typeof radius !== 'number' || !Number.isFinite(radius) || radius < 10 || radius > 2000))
        fail(400, '请设置有效签到地点与 10—2000 米范围')
      const qrText = method !== 'location' ? 'CTP1:' + id + ':' + phase + ':' + crypto.randomBytes(32).toString('hex') : null
      const png = qrText ? await QRCode.toBuffer(qrText, { width: 360, margin: 4, errorCorrectionLevel: 'M' }) : null
      authorize()
      const current = activity(id)
      if (current.status !== 'published') fail(409, '活动已取消')
      if (phase === 'out' && current.starts_at > Date.now()) fail(409, '活动开始后才可开放签退')
      const now = Date.now(), closesAt = now + durationMinutes * 60000
      db.prepare(`INSERT INTO attendance_sessions VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(activity_id,phase) DO UPDATE SET method=excluded.method,qr_hash=excluded.qr_hash,
        opens_at=excluded.opens_at,closes_at=excluded.closes_at,latitude=excluded.latitude,
        longitude=excluded.longitude,radius=excluded.radius,created_by=excluded.created_by`).run(
        id, phase, method, qrText ? digest(qrText) : null, now, closesAt,
        method === 'qr' ? null : latitude, method === 'qr' ? null : longitude, method === 'qr' ? null : radius, actor.id,
      )
      return { phase, method, closesAt, qrText, qrPng: png?.toString('base64') || null }
    },
    close(id, phase) {
      activity(id)
      const result = db.prepare('UPDATE attendance_sessions SET closes_at=? WHERE activity_id=? AND phase=?').run(Date.now(), id, phase)
      if (!result.changes) fail(404, '尚未开放签到')
      return { ok: true }
    },
    record(id, phase, input, user) {
      if (user.role !== 'counselor') fail(403, '仅辅导员可签到')
      const event = activity(id), now = Date.now()
      if (event.status !== 'published') fail(409, '活动已取消')
      if (!db.prepare('SELECT user_id FROM registrations WHERE activity_id=? AND user_id=?').get(id, user.id)) fail(403, '请先报名活动')
      const session = db.prepare('SELECT * FROM attendance_sessions WHERE activity_id=? AND phase=?').get(id, phase)
      if (!session || session.opens_at > now || session.closes_at <= now) fail(409, '尚未开放或已截止，请刷新活动')
      if (db.prepare('SELECT phase FROM attendance_records WHERE activity_id=? AND user_id=? AND phase=?').get(id, user.id, phase)) fail(409, '已完成本次' + (phase === 'in' ? '签到' : '签退'))
      if (phase === 'out' && !db.prepare("SELECT phase FROM attendance_records WHERE activity_id=? AND user_id=? AND phase='in'").get(id, user.id)) fail(409, '请先完成签到')
      if (session.method !== 'location') {
        if (typeof input.qrText !== 'string' || input.qrText.length > 150 || !crypto.timingSafeEqual(Buffer.from(digest(input.qrText), 'hex'), Buffer.from(session.qr_hash, 'hex')))
          fail(403, '二维码无效、已刷新或不属于本次签到')
      }
      let distance = null, accuracy = null
      if (session.method !== 'qr') {
        if (!coordinate(input.latitude, 90) || !coordinate(input.longitude, 180) || typeof input.accuracy !== 'number' || !Number.isFinite(input.accuracy) || input.accuracy < 0 || input.accuracy > session.radius)
          fail(400, '定位无效或精度不足，请到达现场后重试')
        distance = distanceMeters(session.latitude, session.longitude, input.latitude, input.longitude)
        accuracy = input.accuracy
        if (distance > session.radius) fail(403, '当前位置不在签到范围内')
      }
      // 所有检查及写入在同一事件循环内完成，没有异步间隙；主键防重复。
      db.prepare('INSERT INTO attendance_records VALUES(?,?,?,?,?,?,?)').run(id, user.id, phase, session.method, now, distance, accuracy)
      return { phase, recordedAt: now, method: session.method }
    },
  }
}
module.exports = { createAttendance, distanceMeters }
