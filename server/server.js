const http = require('node:http')
const { sendWorkbook } = require('./exports')
const { personalRecords, personalAnnual } = require('./personal')
const { createAuthentication } = require('./auth')
const { migrateCreditUnits } = require('./credit-unit')
const { importRoster, resetPassword } = require('./roster')
const { createAttendance } = require('./attendance')
const { createEvidence, proofList, externalRecords } = require('./evidence')
const { createAudit } = require('./audit')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const pathModule = require('node:path')
let fullFontPromise
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(
  process.env.DB_PATH || require('node:path').join(__dirname, 'training.db'),
)
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','counselor')));
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, location TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'published', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS registrations(activity_id INTEGER NOT NULL REFERENCES activities(id), user_id TEXT NOT NULL REFERENCES users(id), registered_at INTEGER NOT NULL, checked_in_at INTEGER, checked_in_by TEXT REFERENCES users(id), PRIMARY KEY(activity_id,user_id));
CREATE INDEX IF NOT EXISTS registration_user ON registrations(user_id);`)
migrateCreditUnits(db)
const get = (sql, ...args) => db.prepare(sql).get(...args)
if (
  !db
    .prepare('PRAGMA table_info(users)')
    .all()
    .some((c) => c.name === 'enabled')
)
  db.exec('ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
if (
  !db
    .prepare('PRAGMA table_info(activities)')
    .all()
    .some((c) => c.name === 'credit_hours')
)
  db.exec('ALTER TABLE activities ADD COLUMN credit_hours REAL NOT NULL DEFAULT 0')
if (
  !db
    .prepare('PRAGMA table_info(registrations)')
    .all()
    .some((c) => c.name === 'credited_hours')
)
  db.exec('ALTER TABLE registrations ADD COLUMN credited_hours REAL NOT NULL DEFAULT 0')
db.exec(
  "CREATE TABLE IF NOT EXISTS experiences(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, organizer TEXT NOT NULL, occurred_on TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', credit_hours REAL NOT NULL DEFAULT 0, reviewed_by TEXT REFERENCES users(id), reviewed_at INTEGER, review_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
)
if (
  !db
    .prepare('PRAGMA table_info(registrations)')
    .all()
    .some((c) => c.name === 'confirmed_at')
)
  db.exec('ALTER TABLE registrations ADD COLUMN confirmed_at INTEGER')
if (
  !db
    .prepare('PRAGMA table_info(registrations)')
    .all()
    .some((c) => c.name === 'confirmed_by')
)
  db.exec('ALTER TABLE registrations ADD COLUMN confirmed_by TEXT')
if (
  !db
    .prepare('PRAGMA table_info(experiences)')
    .all()
    .some((c) => c.name === 'activity_id')
)
  db.exec('ALTER TABLE experiences ADD COLUMN activity_id INTEGER REFERENCES activities(id)')
db.exec(`CREATE INDEX IF NOT EXISTS experience_user_activity ON experiences(user_id,activity_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS experience_status ON experiences(status,created_at);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
CREATE INDEX IF NOT EXISTS activity_start ON activities(starts_at);`)
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const fail = (status, message) => {
  const e = new Error(message)
  e.status = status
  throw e
}
const send = (res, status, value) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const authentication = createAuthentication(db)
const attendance = createAttendance(db)
const evidence = createEvidence(db)
const audit = createAudit(db)
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const tooLarge = () => {
      chunks.length = 0
      req.pause()
      reject(Object.assign(new Error('请求过大'), { status: 413 }))
    }
    const length = req.headers['content-length']
    if (length !== undefined && Number(length) > 16384) {
      tooLarge()
      return
    }
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 16384) {
        tooLarge()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text ? JSON.parse(text) : {}
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('invalid object')
        if (req.authenticatedUser) requireUser(req)
        resolve(value)
      } catch (error) {
        reject(error.status ? error : Object.assign(new Error('请求格式错误'), { status: 400 }))
      }
    })
    req.on('error', reject)
    req.on('aborted', () => reject(Object.assign(new Error('请求已中断'), { status: 400 })))
  })
}
function requireUser(req) {
  const token = (req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)
  const user =
    token &&
    get(
      'SELECT u.id,u.name,u.department,u.role,u.enabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.enabled=1',
      hash(token[1]),
      Date.now(),
    )
  if (!user) fail(401, '请登录')
  req.authenticatedUser = user.id
  return user
}
function admin(user) {
  if (user.role !== 'admin') fail(403, '无管理员权限')
}
function activityTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return NaN
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10))
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 2000 ||
    year > 2100 ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59
  )
    return NaN
  return Date.parse(value)
}
function activityInput(input) {
  if (
    typeof input.title !== 'string' ||
    (input.description != null && typeof input.description !== 'string') ||
    (input.location != null && typeof input.location !== 'string')
  )
    fail(400, '活动名称、介绍和地点须为文字')
  const capacityValue = typeof input.capacity === 'string' ? input.capacity.trim() : input.capacity
  const numeric = (value) =>
    typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))
  const title = String(input.title || '').trim(),
    description = String(input.description || '').trim(),
    location = String(input.location || '').trim()
  const starts = activityTime(input.startsAt),
    ends = activityTime(input.endsAt),
    capacity =
      capacityValue === undefined || capacityValue === null || capacityValue === ''
        ? 0
        : Number(capacityValue),
    hours = Number(input.creditHours)
  if (
    !title ||
    title.length > 100 ||
    description.length > 2000 ||
    location.length > 200 ||
    !Number.isFinite(starts) ||
    !Number.isFinite(ends) ||
    ends <= starts ||
    !Number.isInteger(capacity) ||
    (capacity !== 0 && !numeric(capacityValue)) ||
    capacity < 0 ||
    (capacity === 0 &&
      capacityValue !== undefined &&
      capacityValue !== null &&
      capacityValue !== '') ||
    capacity > 100000 ||
    !Number.isFinite(hours) || Math.abs(hours * 100 - Math.round(hours * 100)) > 1e-7 ||
    !numeric(input.creditHours) ||
    input.creditHours === undefined ||
    input.creditHours === null ||
    input.creditHours === '' ||
    hours < 0 ||
    hours > 60000
  )
    fail(400, '请填写活动名称、有效起止时间和学时；人数上限如填写须为正整数')
  return [title, description, location, starts, ends, capacity, hours]
}
function dto(a) {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    location: a.location,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    capacity: a.capacity === 0 ? null : a.capacity,
    creditHours: a.credit_hours,
    status: a.status,
    registeredCount: a.registered_count,
    registered: !!a.registered,
    confirmedAt: a.confirmed_at || null,
  }
}
function activity(id, user) {
  const a = get(
    `SELECT a.*, (SELECT COUNT(*) FROM registrations r WHERE r.activity_id=a.id) registered_count, (SELECT 1 FROM registrations r WHERE r.activity_id=a.id AND r.user_id=?) registered, (SELECT confirmed_at FROM registrations r WHERE r.activity_id=a.id AND r.user_id=?) confirmed_at FROM activities a WHERE a.id=?`,
    user.id,
    user.id,
    id,
  )
  if (!a) fail(404, '活动不存在')
  return a
}
function readYear(url) {
  const value = url.searchParams.get('year')
  const year = value === null ? new Date(Date.now() + 8 * 3600000).getUTCFullYear() : Number(value)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, '年份不正确')
  return year
}
function activityList(user, where, args, order) {
  return all(
    `SELECT a.*,COALESCE(counts.registered_count,0) registered_count,
    own.user_id registered,own.confirmed_at confirmed_at FROM activities a
    LEFT JOIN (SELECT activity_id,COUNT(*) registered_count FROM registrations GROUP BY activity_id) counts ON counts.activity_id=a.id
    LEFT JOIN registrations own ON own.activity_id=a.id AND own.user_id=?
    WHERE ${where} ORDER BY ${order}`,
    user.id,
    ...args,
  ).map(dto)
}
function ranking(url) {
  const year = readYear(url)
  const start = Date.parse(year + '-01-01T00:00:00+08:00')
  const end = Date.parse(year + 1 + '-01-01T00:00:00+08:00')
  const external = new Map(all("SELECT user_id,COUNT(*) eventCount,ROUND(SUM(credited_hours),2) totalHours FROM external_trainings WHERE status='approved' AND occurred_on>=? AND occurred_on<? GROUP BY user_id", year + '-01-01', (year + 1) + '-01-01').map(row => [row.user_id, row]))
  const rows = all(
    `SELECT u.id,u.name,u.department,COUNT(a.id) eventCount,
    ROUND(COALESCE(SUM(CASE WHEN a.id IS NOT NULL THEN r.credited_hours ELSE 0 END),0),2) totalHours
    FROM users u LEFT JOIN registrations r ON r.user_id=u.id AND r.confirmed_at IS NOT NULL
    LEFT JOIN activities a ON a.id=r.activity_id AND a.status='published' AND a.starts_at>=? AND a.starts_at<?
    WHERE u.role='counselor' GROUP BY u.id`,
    start,
    end,
  ).map(row => ({ ...row, eventCount: row.eventCount + (external.get(row.id)?.eventCount || 0),
    totalHours: Math.round((row.totalHours + (external.get(row.id)?.totalHours || 0)) * 100) / 100,
  })).sort((a, b) => b.totalHours - a.totalHours || a.id.localeCompare(b.id))
  let previousHours, rank
  return {
    year,
    rows: rows.map((person, index) => {
      if (person.totalHours !== previousHours) rank = index + 1
      previousHours = person.totalHours
      return { ...person, rank }
    }),
  }
}

function withExternalCounts(rows) {
  const counts = new Map(all("SELECT user_id,COUNT(*) submitted,SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved FROM external_trainings GROUP BY user_id").map(row => [row.user_id, row]))
  return rows.map(row => ({ ...row, externalSubmittedCount: counts.get(row.id)?.submitted || 0, externalApprovedCount: counts.get(row.id)?.approved || 0 }))
}

const server = http.createServer((req, res) => audit.run(req, res, async () => {
  try {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
      decodeURI(url.pathname)
    } catch {
      fail(400, '请求地址格式错误')
    }
    const path = url.pathname,
      method = req.method
    if (path === '/health' && method === 'GET') return send(res, 200, { ok: true })
    if (path === '/api/auth/login' && method === 'POST') {
      const input = await body(req)
      if (typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(input.id.trim())) req.auditAccount = input.id.trim()
      return send(res, 200, await authentication.login(input, req.socket.remoteAddress))
    }
    if (path === '/api/auth/password' && method === 'POST') {
      const user = requireUser(req)
      const input = await body(req)
      const result = await authentication.changePassword(user, input, req.socket.remoteAddress, () => requireUser(req))
      return send(res, 200, result)
    }
    if (path === '/fonts/noto-sans-sc-full.woff2' && method === 'GET') {
      if (!fullFontPromise)
        fullFontPromise = fs
          .readFile(pathModule.join(__dirname, 'fonts/noto-sans-sc-full.woff2'))
          .then((buffer) => ({ buffer, etag: '"' + hash(buffer) + '"' }))
          .catch((error) => {
            fullFontPromise = null
            throw error
          })
      const { buffer, etag } = await fullFontPromise
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, {
          ETag: etag,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        })
        return res.end()
      }
      res.writeHead(200, {
        'Content-Type': 'font/woff2',
        'Content-Length': buffer.length,
        ETag: etag,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      })
      return res.end(buffer)
    }
    // This is deliberately disabled in production. Replace with a verified school identity exchange.
    if (path === '/api/auth/dev' && method === 'POST') {
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_LOGIN !== '1')
        fail(404, '接口不存在')
      const b = await body(req),
        id = String(b.id || '').trim(),
        name = String(b.name || '').trim(),
        department = String(b.department || '').trim()
      if (/^[a-zA-Z0-9_-]{1,40}$/.test(id)) req.auditAccount = id
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || !name || name.length > 50 || department.length > 100)
        fail(400, '请填写有效的测试工号和姓名')
      const role = id === process.env.DEV_ADMIN_ID ? 'admin' : 'counselor'
      const existing = get('SELECT * FROM users WHERE id=?', id)
      if (existing && !existing.enabled) fail(403, '该用户已停用')
      if (existing && existing.name !== name) fail(403, '工号与姓名不匹配，请核对后重试')
      if ((!existing || !existing.department) && !department) {
        return send(res, 422, { error: '首次登录，请补充学院或部门', code: 'DEPARTMENT_REQUIRED' })
      }
      if (!existing)
        run(
          'INSERT INTO users(id,name,department,role) VALUES(?,?,?,?)',
          id,
          name,
          department,
          role,
        )
      else if (!existing.department) run('UPDATE users SET department=? WHERE id=?', department, id)
      const token = crypto.randomBytes(32).toString('hex')
      run('DELETE FROM sessions WHERE expires<=?', Date.now())
      run('INSERT INTO sessions VALUES(?,?,?)', hash(token), id, Date.now() + 8 * 3600000)
      const user = get('SELECT id,name,department,role FROM users WHERE id=?', id)
      return send(res, 200, { token, user })
    }
    if (path.startsWith('/api/auth/')) fail(503, '正式身份认证尚未配置')
    const u = requireUser(req)
    if (!['/api/me', '/api/logout'].includes(path) && authentication.mustChange(u.id))
      return send(res, 403, { error: '请先修改初始密码', code: 'PASSWORD_CHANGE_REQUIRED' })
    if (path === '/api/admin/audit-logs' && method === 'GET') {
      admin(u)
      return send(res, 200, audit.list(url))
    }
    if (path === '/api/proofs' && method === 'POST')
      return send(res, 201, await evidence.upload(req, u, () => requireUser(req)))
    const proofMatch = path.match(/^\/api\/proofs\/([a-f0-9]{48})$/)
    if (proofMatch && method === 'GET') {
      const file = await evidence.download(proofMatch[1], u, () => requireUser(req))
      res.writeHead(200, { 'Content-Type': file.mimeType, 'Content-Length': file.buffer.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return res.end(file.buffer)
    }
    const externalMatch = path.match(/^\/api\/my\/external-trainings(?:\/(\d+))?$/)
    if (externalMatch) {
      const id = externalMatch[1] ? Number(externalMatch[1]) : null
      if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) fail(400, '记录编号无效')
      if (method === 'GET' && id) return send(res, 200, evidence.getExternal(id, u))
      if ((method === 'POST' && !id) || (method === 'PUT' && id))
        return send(res, method === 'POST' ? 201 : 200, evidence.submitExternal(id, await body(req), u))
      fail(404, '接口不存在')
    }
    if (path === '/api/admin/external-trainings' && method === 'GET') {
      admin(u)
      return send(res, 200, evidence.adminList())
    }
    const externalReviewMatch = path.match(/^\/api\/admin\/external-trainings\/(\d+)\/review$/)
    if (externalReviewMatch && method === 'POST') {
      admin(u)
      return send(res, 200, evidence.review(Number(externalReviewMatch[1]), await body(req), u))
    }
    const attendanceMatch = path.match(/^\/api\/(admin\/)?activities\/(\d+)\/attendance(?:\/(in|out))?$/)
    if (attendanceMatch) {
      const [, management, activityId, phase] = attendanceMatch, id = Number(activityId)
      if (!Number.isSafeInteger(id) || id <= 0) fail(400, '活动编号无效')
      if (management) {
        admin(u)
        if (method === 'GET' && !phase) return send(res, 200, attendance.report(id))
        if (method === 'POST' && phase) {
          const input = await body(req)
          return send(res, 200, await attendance.open(id, phase, input, u, () => admin(requireUser(req))))
        }
        if (method === 'DELETE' && phase) return send(res, 200, attendance.close(id, phase))
      } else {
        if (method === 'GET' && !phase) return send(res, 200, attendance.state(id, u))
        if (method === 'POST' && phase) return send(res, 200, attendance.record(id, phase, await body(req), u))
      }
      fail(404, '接口不存在')
    }
    if (path === '/api/my/records' && method === 'GET') {
      return send(res, 200, personalRecords(db, u.id))
    }
    if (['/api/my/annual', '/api/my/exports/annual'].includes(path) && method === 'GET') {
      const year = readYear(url)
      const report = personalAnnual(db, u.id, year)
      if (path === '/api/my/annual') return send(res, 200, report)
      return await sendWorkbook(res, year + '-我的年度学时.xlsx', [
        {
          name: '年度汇总',
          columns: [
            { header: '年份', key: 'year', width: 12 },
            { header: '工号', key: 'id', width: 20 },
            { header: '姓名', key: 'name', width: 18 },
            { header: '学院 / 部门', key: 'department', width: 28 },
            { header: '活动数（含自行提交和取消）', key: 'activityCount', width: 26 },
            { header: '审核通过数', key: 'approvedCount', width: 18 },
            { header: '未审核数（含未提交）', key: 'pendingCount', width: 26 },
            { header: '驳回数', key: 'rejectedCount', width: 12 },
            { header: '取消数', key: 'cancelledCount', width: 12 },
            { header: '认定学时', key: 'totalHours', width: 24 },
          ],
          rows: [{ ...report, id: u.id, name: u.name, department: u.department }],
        },
        {
          name: '我的活动记录',
          columns: [
            { header: '活动名称', key: 'title', width: 36 },
            {
              header: '活动时间（北京时间）',
              key: 'activityDate',
              width: 28,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
            { header: '地点', key: 'location', width: 28 },
            { header: '活动学时', key: 'creditHours', width: 24 },
            { header: '认定学时', key: 'recognizedHours', width: 24 },
            { header: '审核情况', key: 'reviewLabel', width: 20 },
            { header: '培训经历', key: 'experience', width: 50 },
            { header: '审核意见', key: 'reviewNote', width: 40 },
            {
              header: '确认参加时间（北京时间）',
              key: 'confirmationDate',
              width: 30,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
          ],
          rows: report.records.map((r) => ({
            ...r,
            location: r.location || '地点待定',
            activityDate: new Date(r.startsAt + 8 * 3600000),
            confirmationDate: r.confirmedAt ? new Date(r.confirmedAt + 8 * 3600000) : null,
          })),
        },
      ])
    }
    if (path === '/api/me' && method === 'GET') return send(res, 200, u)
    if (path === '/api/logout' && method === 'POST') {
      run('DELETE FROM sessions WHERE token_hash=?', hash(req.headers.authorization.slice(7)))
      return send(res, 200, { ok: true })
    }
    if (path === '/api/admin/users' && method === 'GET') {
      admin(u)
      const q = String(url.searchParams.get('q') || '')
        .trim()
        .slice(0, 100)
      return send(
        res,
        200,
        all(
          "SELECT id,name,department,enabled FROM users WHERE role='counselor' AND (instr(id,?)>0 OR instr(name,?)>0 OR instr(department,?)>0) ORDER BY enabled DESC,department,name,id",
          q,
          q,
          q,
        ),
      )
    }
    if (path === '/api/admin/users' && method === 'POST') {
      admin(u)
      const b = await body(req)
      if (b.initialPassword !== undefined || process.env.NODE_ENV === 'production') {
        await importRoster(db, [{ ...b, role: 'counselor' }], { authorize: () => admin(requireUser(req)) })
        return send(res, 201, { id: b.id, name: b.name, department: b.department, enabled: 1 })
      }
      const id = String(b.id || '').trim(),
        name = String(b.name || '').trim(),
        department = String(b.department || '').trim()
      if (
        !/^[a-zA-Z0-9_-]{1,40}$/.test(id) ||
        !name ||
        name.length > 50 ||
        !department ||
        department.length > 100
      )
        fail(400, '请填写有效工号、姓名和部门')
      if (id === process.env.DEV_ADMIN_ID || get('SELECT id FROM users WHERE id=?', id))
        fail(409, '该工号已存在或已保留')
      run(
        "INSERT INTO users(id,name,department,role) VALUES(?,?,?,'counselor')",
        id,
        name,
        department,
      )
      return send(res, 201, { id, name, department, enabled: 1 })
    }
    if (path === '/api/admin/users/import' && method === 'POST') {
      admin(u)
      const b = await body(req)
      if (!Array.isArray(b.rows) || b.rows.length > 50) fail(400, '每批最多导入 50 人')
      return send(res, 201, await importRoster(db, b.rows, { authorize: () => admin(requireUser(req)) }))
    }
    const resetMatch = path.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]{1,40})\/password$/)
    if (resetMatch && method === 'POST') {
      const authorize = () => {
        admin(requireUser(req))
        if (!get("SELECT id FROM users WHERE id=? AND role='counselor'", resetMatch[1])) fail(404, '辅导员不存在')
      }
      authorize()
      const b = await body(req)
      return send(res, 200, await resetPassword(db, resetMatch[1], b.initialPassword, authorize))
    }
    const userMatch = path.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]{1,40})$/)
    if (userMatch && method === 'PUT') {
      admin(u)
      const b = await body(req),
        id = userMatch[1],
        name = String(b.name || '').trim(),
        department = String(b.department || '').trim()
      if (
        !name ||
        name.length > 50 ||
        !department ||
        department.length > 100 ||
        (b.enabled !== undefined && ![0, 1].includes(b.enabled))
      )
        fail(400, '请填写有效姓名、部门和状态')
      const existing = get("SELECT id,enabled FROM users WHERE id=? AND role='counselor'", id)
      if (!existing) fail(404, '辅导员不存在')
      const enabled = b.enabled === undefined ? existing.enabled : b.enabled
      run(
        'UPDATE users SET name=?,department=?,enabled=? WHERE id=?',
        name,
        department,
        enabled,
        id,
      )
      if (!enabled) run('DELETE FROM sessions WHERE user_id=?', id)
      return send(res, 200, { id, name, department, enabled })
    }
    if (path === '/api/experiences' && method === 'GET')
      return send(
        res,
        200,
        all(
          'SELECT id,activity_id activityId,title,description,status,credit_hours creditHours,review_note reviewNote FROM experiences WHERE user_id=? ORDER BY created_at DESC',
          u.id,
        ),
      )
    if (path === '/api/experiences' && method === 'POST') {
      const b = await body(req),
        id = Number(b.activityId),
        description = String(b.description || '').trim()
      if (!Number.isInteger(id) || !description || description.length > 2000)
        fail(400, '请选择活动并填写培训经历')
      const a = activity(id, u)
      if (!a.registered || a.status !== 'published')
        fail(409, '只能提交已报名且未取消活动的培训经历')
      if (a.starts_at > Date.now()) fail(409, '活动尚未开始，请参加后再提交培训经历')
      if (
        get(
          "SELECT id FROM experiences WHERE user_id=? AND activity_id=? AND status IN ('pending','approved')",
          u.id,
          id,
        )
      )
        fail(409, '该活动已有待审核或已通过的经历')
      return send(res, 201, evidence.createExperience(a, u, description, b.proofIds))
    }
    if (path === '/api/admin/experiences' && method === 'GET') {
      admin(u)
      return send(
        res,
        200,
        all(
          "SELECT e.id,e.activity_id activityId,e.title,e.description,e.status,e.credit_hours creditHours,e.review_note reviewNote,u.name,u.department,u.id userId FROM experiences e JOIN users u ON e.user_id=u.id ORDER BY CASE WHEN e.status='pending' THEN 0 ELSE 1 END,e.created_at DESC",
        ).map(record => ({ ...record, proofs: proofList(db, 'experience_id', record.id) })),
      )
    }
    const reviewMatch = path.match(/^\/api\/admin\/experiences\/(\d+)\/review$/)
    if (reviewMatch && method === 'POST') {
      admin(u)
      const b = await body(req),
        status = String(b.status || ''),
        note = String(b.note || '').trim()
      if (
        !['approved', 'rejected'].includes(status) ||
        note.length > 500 ||
        (status === 'rejected' && !note)
      )
        fail(400, '请填写有效的审核结果或驳回原因')
      db.exec('BEGIN IMMEDIATE')
      try {
        const exp = get('SELECT * FROM experiences WHERE id=?', Number(reviewMatch[1]))
        if (!exp || exp.status !== 'pending') fail(409, '记录不存在或已审核')
        const a = exp.activity_id ? activity(exp.activity_id, { id: exp.user_id }) : null
        if (status === 'approved') {
          if (!a) fail(409, '旧版记录未关联活动，可驳回后让老师重新提交')
          if (a.status !== 'published' || !a.registered) fail(409, '活动已取消或报名不存在')
          if (a.starts_at > Date.now()) fail(409, '活动尚未开始，不能确认参加')
          evidence.preventDuplicateCredit(a, exp.user_id)
          run(
            'UPDATE registrations SET confirmed_at=COALESCE(confirmed_at,?),confirmed_by=COALESCE(confirmed_by,?),credited_hours=CASE WHEN confirmed_at IS NULL THEN ? ELSE credited_hours END WHERE activity_id=? AND user_id=?',
            Date.now(),
            u.id,
            a.credit_hours,
            a.id,
            exp.user_id,
          )
        }
        run(
          'UPDATE experiences SET status=?,credit_hours=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?',
          status,
          status === 'approved' ? a.credit_hours : 0,
          note,
          u.id,
          Date.now(),
          exp.id,
        )
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return send(res, 200, { ok: true })
    }
    if (path === '/api/activities' && method === 'GET') {
      const yearText = url.searchParams.get('year')
      let yearFilter = ''
      const args = []
      if (yearText !== null) {
        const year = Number(yearText)
        if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, '年份不正确')
        yearFilter = ' AND a.starts_at>=? AND a.starts_at<?'
        args.push(
          Date.parse(year + '-01-01T00:00:00+08:00'),
          Date.parse(year + 1 + '-01-01T00:00:00+08:00'),
        )
      }
      return send(
        res,
        200,
        activityList(
          u,
          "a.status='published'" + yearFilter,
          [...args, Date.now()],
          'CASE WHEN a.ends_at>? THEN 0 ELSE 1 END,a.starts_at DESC,a.id DESC',
        ),
      )
    }
    if (path === '/api/records' && method === 'GET') {
      const ids = all(
        'SELECT activity_id FROM registrations WHERE user_id=? ORDER BY registered_at DESC',
        u.id,
      )
      return send(
        res,
        200,
        ids.map((x) => dto(activity(x.activity_id, u))),
      )
    }
    if (path === '/api/admin/ranking' && method === 'GET') {
      admin(u)
      return send(res, 200, ranking(url))
    }
    if (path === '/api/admin/review-count' && method === 'GET') {
      admin(u)
      return send(
        res,
        200,
        get("SELECT (SELECT COUNT(*) FROM experiences WHERE status='pending') + (SELECT COUNT(*) FROM external_trainings WHERE status='pending') pendingCount"),
      )
    }
    if (path === '/api/admin/exports/ranking' && method === 'GET') {
      admin(u)
      const report = ranking(url)
      return await sendWorkbook(res, report.year + '-年度学时排名.xlsx', [
        {
          name: report.year + '年度学时排名',
          columns: [
            { header: '排名', key: 'rank', width: 10 },
            { header: '工号', key: 'id', width: 20 },
            { header: '姓名', key: 'name', width: 18 },
            { header: '学院 / 部门', key: 'department', width: 28 },
            { header: '认定活动次数', key: 'eventCount', width: 20 },
            { header: '累计学时', key: 'totalHours', width: 24 },
          ],
          rows: report.rows,
        },
      ])
    }
    if (path === '/api/admin/exports/people' && method === 'GET') {
      admin(u)
      const summary = withExternalCounts(all(
        "SELECT u.id,u.name,u.department,COUNT(r.activity_id) registeredCount,COUNT(r.confirmed_at) confirmedCount FROM users u LEFT JOIN registrations r ON r.user_id=u.id WHERE u.role='counselor' GROUP BY u.id ORDER BY u.department,u.name,u.id",
      ))
      const details = all(
        "SELECT u.id,u.name,u.department,a.title,a.starts_at startsAt,a.location,a.status,r.registered_at registeredAt,r.confirmed_at confirmedAt,r.credited_hours creditedHours FROM registrations r JOIN users u ON u.id=r.user_id JOIN activities a ON a.id=r.activity_id WHERE u.role='counselor' ORDER BY u.department,u.id,a.starts_at",
      )
      const externalRows = all("SELECT u.id,u.name,u.department,e.title,e.organizer,e.occurred_on occurredOn,e.requested_hours requestedHours,e.credited_hours creditHours,e.status,e.review_note reviewNote FROM external_trainings e JOIN users u ON u.id=e.user_id ORDER BY e.occurred_on DESC,e.id DESC")
      const formatTime = (value) => (value ? new Date(value + 8 * 3600000) : null)
      return await sendWorkbook(res, '人员报名情况.xlsx', [
        {
          name: '人员汇总',
          columns: [
            { header: '工号', key: 'id', width: 20 },
            { header: '姓名', key: 'name', width: 18 },
            { header: '学院 / 部门', key: 'department', width: 28 },
            { header: '报名次数（含取消活动）', key: 'registeredCount', width: 28 },
            { header: '已确认次数（含取消活动）', key: 'confirmedCount', width: 30 },
            { header: '自行提交次数', key: 'externalSubmittedCount', width: 20 },
            { header: '自行提交通过次数', key: 'externalApprovedCount', width: 22 },
          ],
          rows: summary,
        },
        {
          name: '报名明细',
          columns: [
            { header: '工号', key: 'id', width: 20 },
            { header: '姓名', key: 'name', width: 18 },
            { header: '学院 / 部门', key: 'department', width: 28 },
            { header: '活动名称', key: 'title', width: 36 },
            {
              header: '活动时间（北京时间）',
              key: 'startsText',
              width: 28,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
            { header: '地点', key: 'location', width: 28 },
            {
              header: '报名时间（北京时间）',
              key: 'registeredText',
              width: 28,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
            { header: '参加状态', key: 'state', width: 20 },
            { header: '计入学时', key: 'hours', width: 24 },
          ],
          rows: details.map((r) => ({
            ...r,
            startsText: formatTime(r.startsAt),
            registeredText: formatTime(r.registeredAt),
            state:
              r.status === 'cancelled' ? '活动已取消' : r.confirmedAt ? '已确认参加' : '待确认参加',
            hours: r.status === 'published' && r.confirmedAt ? r.creditedHours : 0,
          })),
        },
        ...(externalRows.length ? [{ name: '自行提交活动', columns: [
          { header: '工号', key: 'id', width: 20 }, { header: '姓名', key: 'name', width: 18 },
          { header: '学院 / 部门', key: 'department', width: 28 }, { header: '活动名称', key: 'title', width: 36 },
          { header: '主办方', key: 'organizer', width: 28 }, { header: '参加日期', key: 'occurredOn', width: 18 },
          { header: '申请学时', key: 'requestedHours', width: 16 }, { header: '认定学时', key: 'creditHours', width: 16 },
          { header: '审核状态', key: 'status', width: 18 }, { header: '审核意见', key: 'reviewNote', width: 40 },
        ], rows: externalRows.map(row => ({ ...row, status: { pending: '待审核', approved: '已通过', rejected: '已驳回' }[row.status] })) }] : []),
      ])
    }
    if (path === '/api/admin/people' && method === 'GET') {
      admin(u)
      return send(
        res,
        200,
        withExternalCounts(all(
          "SELECT u.id,u.name,u.department,COUNT(r.activity_id) registeredCount,COUNT(r.confirmed_at) confirmedCount FROM users u LEFT JOIN registrations r ON r.user_id=u.id WHERE u.role='counselor' GROUP BY u.id ORDER BY u.department,u.name",
        )),
      )
    }
    if (path === '/api/admin/person-records' && method === 'GET') {
      admin(u)
      const userId = url.searchParams.get('id')
      if (!userId || !get('SELECT id FROM users WHERE id=?', userId)) fail(404, '人员不存在')
      const person = { id: userId }
      return send(
        res,
        200,
        all(
          'SELECT activity_id FROM registrations WHERE user_id=? ORDER BY registered_at DESC',
          userId,
        ).map((x) => dto(activity(x.activity_id, person))).concat(externalRecords(db, userId).map(record => ({ ...record, registered: true, endsAt: record.startsAt, description: record.experience }))),
      )
    }
    if (path === '/api/admin/activities' && method === 'GET') {
      admin(u)
      return send(res, 200, activityList(u, '1=1', [], 'a.created_at DESC,a.id DESC'))
    }
    if (path === '/api/admin/activities' && method === 'POST') {
      admin(u)
      const v = activityInput(await body(req))
      const r = run(
        'INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ...v,
        Date.now(),
      )
      return send(res, 201, dto(activity(Number(r.lastInsertRowid), u)))
    }
    let m = path.match(/^\/api\/activities\/(\d+)$/)
    if (m && method === 'GET') {
      const a = activity(Number(m[1]), u)
      if (a.status !== 'published' && !a.registered && u.role !== 'admin') fail(404, '活动不存在')
      return send(res, 200, dto(a))
    }
    m = path.match(/^\/api\/activities\/(\d+)\/register$/)
    if (m && method === 'POST') {
      const id = Number(m[1])
      db.exec('BEGIN IMMEDIATE')
      try {
        const a = activity(id, u)
        if (a.status !== 'published' || a.starts_at <= Date.now())
          fail(409, '活动已取消或报名已截止')
        if (a.registered) fail(409, '您已报名')
        if (a.capacity > 0 && a.registered_count >= a.capacity) fail(409, '报名人数已满')
        run(
          'INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,?,?)',
          id,
          u.id,
          Date.now(),
        )
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return send(res, 200, dto(activity(id, u)))
    }
    m = path.match(/^\/api\/admin\/activities\/(\d+)$/)
    if (m && method === 'PUT') {
      admin(u)
      const input = await body(req)
      const id = Number(m[1]),
        a = activity(id, u),
        v = activityInput(input)
      if (a.status !== 'published') fail(409, '已取消的活动不能修改')
      if (v[5] > 0 && v[5] < a.registered_count) fail(409, '人数上限不能少于已报名人数')
      if (
        get(
          'SELECT 1 AS found FROM registrations WHERE activity_id=? AND confirmed_at IS NOT NULL LIMIT 1',
          id,
        ) &&
        (v[6] !== a.credit_hours || v[3] !== a.starts_at)
      )
        fail(409, '已有参加确认，不能更改开始时间或学时')
      run(
        'UPDATE activities SET title=?,description=?,location=?,starts_at=?,ends_at=?,capacity=?,credit_hours=? WHERE id=?',
        ...v,
        id,
      )
      return send(res, 200, dto(activity(id, u)))
    }
    if (m && method === 'DELETE') {
      admin(u)
      const id = Number(m[1])
      activity(id, u)
      db.exec('BEGIN IMMEDIATE')
      try {
        run("UPDATE activities SET status='cancelled' WHERE id=?", id)
        run(
          "UPDATE experiences SET status='rejected',credit_hours=0,review_note='活动已取消',reviewed_by=?,reviewed_at=? WHERE activity_id=? AND status='pending'",
          u.id,
          Date.now(),
          id,
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return send(res, 200, { ok: true })
    }
    m = path.match(/^\/api\/admin\/activities\/(\d+)\/attendees$/)
    if (m && method === 'GET') {
      admin(u)
      activity(Number(m[1]), u)
      return send(
        res,
        200,
        all(
          'SELECT u.id,u.name,u.department,r.registered_at registeredAt,r.confirmed_at confirmedAt FROM registrations r JOIN users u ON r.user_id=u.id WHERE r.activity_id=? ORDER BY r.registered_at',
          Number(m[1]),
        ),
      )
    }
    m = path.match(/^\/api\/admin\/activities\/(\d+)\/confirm$/)
    if (m && method === 'POST') {
      admin(u)
      const id = Number(m[1]),
        b = await body(req),
        a = activity(id, u)
      if (a.status !== 'published' || a.starts_at > Date.now()) fail(409, '活动已取消或尚未开始')
      db.exec('BEGIN IMMEDIATE')
      try {
        evidence.preventDuplicateCredit(a, String(b.userId || ''))
        const result = run(
          'UPDATE registrations SET confirmed_at=?,confirmed_by=?,credited_hours=? WHERE activity_id=? AND user_id=? AND confirmed_at IS NULL',
          Date.now(),
          u.id,
          a.credit_hours,
          id,
          String(b.userId || ''),
        )
        if (!result.changes) fail(409, '未报名或已确认参加')
        run(
          "UPDATE experiences SET status='approved',credit_hours=?,reviewed_by=?,reviewed_at=?,review_note=CASE WHEN review_note='' THEN '管理员已确认参加' ELSE review_note END WHERE activity_id=? AND user_id=? AND status='pending'",
          a.credit_hours,
          u.id,
          Date.now(),
          id,
          String(b.userId || ''),
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return send(res, 200, { ok: true })
    }
    fail(404, '接口不存在')
  } catch (e) {
    if (!e.status) console.error(e)
    if (e.status === 413) {
      // 无需等待客户端发送完请求体；响应发出后由 HTTP 层关闭连接。
      res.shouldKeepAlive = false
      res.setHeader('Connection', 'close')
    }
    if (!res.headersSent && !res.destroyed)
      send(res, e.status || 500, { error: e.status ? e.message : '服务器内部错误' })
  }
}))
if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1'
  server.listen({ port: Number(process.env.PORT || 3000), host, backlog: 2048 }, () =>
    console.log(`Listening on ${host}:${server.address().port}`),
  )
}
server.requestTimeout = 15000
server.headersTimeout = 10000
module.exports = { server, db }
