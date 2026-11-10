const http = require('node:http')
const { sendWorkbook } = require('./exports')
const crypto = require('node:crypto')
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
    .some((c) => c.name === 'credit_minutes')
)
  db.exec('ALTER TABLE activities ADD COLUMN credit_minutes INTEGER NOT NULL DEFAULT 0')
if (
  !db
    .prepare('PRAGMA table_info(registrations)')
    .all()
    .some((c) => c.name === 'credited_minutes')
)
  db.exec('ALTER TABLE registrations ADD COLUMN credited_minutes INTEGER NOT NULL DEFAULT 0')
db.exec(
  "CREATE TABLE IF NOT EXISTS experiences(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, organizer TEXT NOT NULL, occurred_on TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', credit_minutes INTEGER NOT NULL DEFAULT 0, reviewed_by TEXT REFERENCES users(id), reviewed_at INTEGER, review_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
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
function body(req) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (chunk) => {
      s += chunk
      if (s.length > 16384) {
        reject(Object.assign(new Error('请求过大'), { status: 413 }))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {})
      } catch {
        reject(Object.assign(new Error('请求格式错误'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}
function requireUser(req) {
  const token = (req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)
  const user =
    token &&
    get(
      'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.enabled=1',
      hash(token[1]),
      Date.now(),
    )
  if (!user) fail(401, '请登录')
  return user
}
function admin(user) {
  if (user.role !== 'admin') fail(403, '无管理员权限')
}
function activityInput(input) {
  const title = String(input.title || '').trim(),
    description = String(input.description || '').trim(),
    location = String(input.location || '').trim()
  const starts = Date.parse(input.startsAt),
    ends = Date.parse(input.endsAt),
    capacity =
      input.capacity === undefined || input.capacity === null || input.capacity === ''
        ? 0
        : Number(input.capacity),
    minutes = Number(input.creditMinutes)
  if (
    !title ||
    title.length > 100 ||
    description.length > 2000 ||
    location.length > 200 ||
    !Number.isFinite(starts) ||
    !Number.isFinite(ends) ||
    ends <= starts ||
    !Number.isInteger(capacity) ||
    capacity < 0 ||
    (capacity === 0 &&
      input.capacity !== undefined &&
      input.capacity !== null &&
      input.capacity !== '') ||
    capacity > 100000 ||
    !Number.isInteger(minutes) ||
    input.creditMinutes === undefined ||
    input.creditMinutes === null ||
    input.creditMinutes === '' ||
    minutes < 0 ||
    minutes > 60000
  )
    fail(400, '请填写活动名称、有效起止时间和学时；人数上限如填写须为正整数')
  return [title, description, location, starts, ends, capacity, minutes]
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
    creditMinutes: a.credit_minutes,
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
function ranking(url) {
  const year = Number(
    url.searchParams.get('year') || new Date(Date.now() + 8 * 3600000).getUTCFullYear(),
  )
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, '年份不正确')
  const start = Date.parse(year + '-01-01T00:00:00+08:00'),
    end = Date.parse(year + 1 + '-01-01T00:00:00+08:00')
  const rows = all("SELECT id,name,department FROM users WHERE role='counselor' ORDER BY id")
    .map((person) => {
      const event = get(
        "SELECT COUNT(*) count, COALESCE(SUM(r.credited_minutes),0) minutes FROM registrations r JOIN activities a ON a.id=r.activity_id WHERE r.user_id=? AND r.confirmed_at IS NOT NULL AND a.status='published' AND a.starts_at>=? AND a.starts_at<?",
        person.id,
        start,
        end,
      )
      return { ...person, eventCount: event.count, totalMinutes: event.minutes }
    })
    .sort((a, b) => b.totalMinutes - a.totalMinutes || a.id.localeCompare(b.id))
  return {
    year,
    rows: rows.map((person) => ({
      ...person,
      rank: rows.findIndex((row) => row.totalMinutes === person.totalMinutes) + 1,
    })),
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'),
      path = url.pathname,
      method = req.method
    if (path === '/health' && method === 'GET') return send(res, 200, { ok: true })
    // This is deliberately disabled in production. Replace with a verified school identity exchange.
    if (path === '/api/auth/dev' && method === 'POST') {
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_LOGIN !== '1')
        fail(404, '接口不存在')
      const b = await body(req),
        id = String(b.id || '').trim(),
        name = String(b.name || '').trim(),
        department = String(b.department || '').trim()
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || !name || name.length > 50 || department.length > 100)
        fail(400, '请填写有效的测试工号和姓名')
      const role = id === process.env.DEV_ADMIN_ID ? 'admin' : 'counselor'
      const existing = get('SELECT * FROM users WHERE id=?', id)
      if (existing && !existing.enabled) fail(403, '该用户已停用')
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
      run('INSERT INTO sessions VALUES(?,?,?)', hash(token), id, Date.now() + 8 * 3600000)
      const user = get('SELECT id,name,department,role FROM users WHERE id=?', id)
      return send(res, 200, { token, user })
    }
    if (path.startsWith('/api/auth/')) fail(503, '学校统一身份认证尚未接入')
    const u = requireUser(req)
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
          "SELECT id,name,department,enabled FROM users WHERE role='counselor' AND (instr(id,?)>0 OR instr(name,?)>0 OR instr(department,?)>0) ORDER BY enabled DESC,department,name,id LIMIT 1000",
          q,
          q,
          q,
        ),
      )
    }
    if (path === '/api/admin/users' && method === 'POST') {
      admin(u)
      const b = await body(req),
        id = String(b.id || '').trim(),
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
        ![0, 1].includes(b.enabled)
      )
        fail(400, '请填写有效姓名、部门和状态')
      const existing = get("SELECT id FROM users WHERE id=? AND role='counselor'", id)
      if (!existing) fail(404, '辅导员不存在')
      run(
        'UPDATE users SET name=?,department=?,enabled=? WHERE id=?',
        name,
        department,
        b.enabled,
        id,
      )
      if (!b.enabled) run('DELETE FROM sessions WHERE user_id=?', id)
      return send(res, 200, { id, name, department, enabled: b.enabled })
    }
    if (path === '/api/experiences' && method === 'GET')
      return send(
        res,
        200,
        all(
          'SELECT id,activity_id activityId,title,description,status,credit_minutes creditMinutes,review_note reviewNote FROM experiences WHERE user_id=? ORDER BY created_at DESC LIMIT 500',
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
      if (
        get(
          "SELECT id FROM experiences WHERE user_id=? AND activity_id=? AND status IN ('pending','approved')",
          u.id,
          id,
        )
      )
        fail(409, '该活动已有待审核或已通过的经历')
      const date = new Date(a.starts_at + 8 * 3600000).toISOString().slice(0, 10)
      const result = run(
        'INSERT INTO experiences(user_id,activity_id,title,organizer,occurred_on,description,created_at) VALUES(?,?,?,?,?,?,?)',
        u.id,
        id,
        a.title,
        '平台活动',
        date,
        description,
        Date.now(),
      )
      return send(res, 201, { id: Number(result.lastInsertRowid), status: 'pending' })
    }
    if (path === '/api/admin/experiences' && method === 'GET') {
      admin(u)
      return send(
        res,
        200,
        all(
          "SELECT e.id,e.activity_id activityId,e.title,e.description,e.status,e.credit_minutes creditMinutes,e.review_note reviewNote,u.name,u.department,u.id userId FROM experiences e JOIN users u ON e.user_id=u.id ORDER BY CASE WHEN e.status='pending' THEN 0 ELSE 1 END,e.created_at DESC LIMIT 500",
        ),
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
        if (!exp.activity_id) fail(409, '旧版记录未关联活动，请重新提交')
        const a = activity(exp.activity_id, { id: exp.user_id })
        if (status === 'approved') {
          if (a.status !== 'published' || !a.registered) fail(409, '活动已取消或报名不存在')
          if (a.starts_at > Date.now()) fail(409, '活动尚未开始，不能确认参加')
          run(
            'UPDATE registrations SET confirmed_at=COALESCE(confirmed_at,?),confirmed_by=COALESCE(confirmed_by,?),credited_minutes=CASE WHEN confirmed_at IS NULL THEN ? ELSE credited_minutes END WHERE activity_id=? AND user_id=?',
            Date.now(),
            u.id,
            a.credit_minutes,
            a.id,
            exp.user_id,
          )
        }
        run(
          'UPDATE experiences SET status=?,credit_minutes=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?',
          status,
          status === 'approved' ? a.credit_minutes : 0,
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
      const ids = all(
        "SELECT a.id FROM activities a WHERE a.status='published' ORDER BY CASE WHEN a.ends_at>? THEN 0 ELSE 1 END, a.starts_at DESC LIMIT 500",
        Date.now(),
      )
      return send(
        res,
        200,
        ids.map((x) => dto(activity(x.id, u))),
      )
    }
    if (path === '/api/records' && method === 'GET') {
      const ids = all(
        'SELECT activity_id FROM registrations WHERE user_id=? ORDER BY registered_at DESC LIMIT 500',
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
        get("SELECT COUNT(*) pendingCount FROM experiences WHERE status='pending'"),
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
            { header: '确认参加次数', key: 'eventCount', width: 20 },
            { header: '累计学时（分钟）', key: 'totalMinutes', width: 24 },
          ],
          rows: report.rows,
        },
      ])
    }
    if (path === '/api/admin/exports/people' && method === 'GET') {
      admin(u)
      const summary = all(
        "SELECT u.id,u.name,u.department,COUNT(r.activity_id) registeredCount,COUNT(r.confirmed_at) confirmedCount FROM users u LEFT JOIN registrations r ON r.user_id=u.id WHERE u.role='counselor' GROUP BY u.id ORDER BY u.department,u.name,u.id",
      )
      const details = all(
        "SELECT u.id,u.name,u.department,a.title,a.starts_at startsAt,a.location,a.status,r.registered_at registeredAt,r.confirmed_at confirmedAt,r.credited_minutes creditedMinutes FROM registrations r JOIN users u ON u.id=r.user_id JOIN activities a ON a.id=r.activity_id WHERE u.role='counselor' ORDER BY u.department,u.id,a.starts_at",
      )
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
            { header: '计入学时（分钟）', key: 'minutes', width: 24 },
          ],
          rows: details.map((r) => ({
            ...r,
            startsText: formatTime(r.startsAt),
            registeredText: formatTime(r.registeredAt),
            state:
              r.status === 'cancelled' ? '活动已取消' : r.confirmedAt ? '已确认参加' : '待确认参加',
            minutes: r.status === 'published' && r.confirmedAt ? r.creditedMinutes : 0,
          })),
        },
      ])
    }
    if (path === '/api/admin/people' && method === 'GET') {
      admin(u)
      return send(
        res,
        200,
        all(
          "SELECT u.id,u.name,u.department,COUNT(r.activity_id) registeredCount,COUNT(r.confirmed_at) confirmedCount FROM users u LEFT JOIN registrations r ON r.user_id=u.id WHERE u.role='counselor' GROUP BY u.id ORDER BY u.department,u.name LIMIT 500",
        ),
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
          'SELECT activity_id FROM registrations WHERE user_id=? ORDER BY registered_at DESC LIMIT 500',
          userId,
        ).map((x) => dto(activity(x.activity_id, person))),
      )
    }
    if (path === '/api/admin/activities' && method === 'GET') {
      admin(u)
      return send(
        res,
        200,
        all('SELECT id FROM activities ORDER BY created_at DESC LIMIT 500').map((x) =>
          dto(activity(x.id, u)),
        ),
      )
    }
    if (path === '/api/admin/activities' && method === 'POST') {
      admin(u)
      const v = activityInput(await body(req))
      const r = run(
        'INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,credit_minutes,created_at) VALUES(?,?,?,?,?,?,?,?)',
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
      const id = Number(m[1]),
        a = activity(id, u),
        v = activityInput(await body(req))
      if (a.status !== 'published') fail(409, '已取消的活动不能修改')
      if (v[5] > 0 && v[5] < a.registered_count) fail(409, '人数上限不能少于已报名人数')
      if (
        get(
          'SELECT 1 AS found FROM registrations WHERE activity_id=? AND confirmed_at IS NOT NULL LIMIT 1',
          id,
        ) &&
        (v[6] !== a.credit_minutes || v[3] !== a.starts_at)
      )
        fail(409, '已有参加确认，不能更改开始时间或学时')
      run(
        'UPDATE activities SET title=?,description=?,location=?,starts_at=?,ends_at=?,capacity=?,credit_minutes=? WHERE id=?',
        ...v,
        id,
      )
      return send(res, 200, dto(activity(id, u)))
    }
    if (m && method === 'DELETE') {
      admin(u)
      const id = Number(m[1])
      activity(id, u)
      run("UPDATE activities SET status='cancelled' WHERE id=?", id)
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
      const result = run(
        'UPDATE registrations SET confirmed_at=?,confirmed_by=?,credited_minutes=? WHERE activity_id=? AND user_id=? AND confirmed_at IS NULL',
        Date.now(),
        u.id,
        a.credit_minutes,
        id,
        String(b.userId || ''),
      )
      if (!result.changes) fail(409, '未报名或已确认参加')
      return send(res, 200, { ok: true })
    }
    fail(404, '接口不存在')
  } catch (e) {
    if (!e.status) console.error(e)
    if (!res.headersSent)
      send(res, e.status || 500, { error: e.status ? e.message : '服务器内部错误' })
  }
})
if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1'
  server.listen({ port: Number(process.env.PORT || 3000), host, backlog: 2048 }, () =>
    console.log(`Listening on ${host}:${server.address().port}`),
  )
}
module.exports = { server, db }
