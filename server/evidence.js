const { pageQuery, mapPage } = require('./pagination')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const MAX_FILE = 5 * 1024 * 1024
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
const validHours = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 60000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7
function proofList(db, field, id) {
  if (!id) return []
  if (!['experience_id', 'external_id'].includes(field)) throw new Error('Invalid proof target')
  return db.prepare('SELECT id,name,mime_type mimeType,bytes size FROM proof_files WHERE ' + field + '=? ORDER BY created_at,id').all(id)
}
function collectFile(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const oversized = () => {
      chunks.length = 0; req.pause()
      reject(Object.assign(new Error('证明材料不能超过 5 MB'), { status: 413 }))
    }
    req.on('error', reject)
    req.on('aborted', () => reject(Object.assign(new Error('上传已中断'), { status: 400 })))
    if (Number(req.headers['content-length']) > MAX_FILE) return oversized()
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_FILE) return oversized()
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}
function fileType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
  if (buffer.length > 5 && buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf'
  fail(400, '仅支持 JPG、PNG 图片和 PDF 证明文件')
}
function createEvidence(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS external_trainings(
    id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,organizer TEXT NOT NULL,
    occurred_on TEXT NOT NULL,requested_hours REAL NOT NULL,description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    credited_hours REAL NOT NULL DEFAULT 0,reviewed_by TEXT REFERENCES users(id),reviewed_at INTEGER,
    review_note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,
    UNIQUE(user_id,title,occurred_on));
    CREATE INDEX IF NOT EXISTS external_user ON external_trainings(user_id,occurred_on);
    CREATE INDEX IF NOT EXISTS external_status ON external_trainings(status,created_at);
    CREATE TABLE IF NOT EXISTS proof_files(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,
    external_id INTEGER REFERENCES external_trainings(id),experience_id INTEGER REFERENCES experiences(id));
    CREATE INDEX IF NOT EXISTS proof_owner ON proof_files(user_id);
    CREATE INDEX IF NOT EXISTS proof_external ON proof_files(external_id);
    CREATE INDEX IF NOT EXISTS proof_experience ON proof_files(experience_id);`)
  const root = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'))
  let uploads = 0, downloads = 0
  function validateProofs(ids, user, externalId = null, required = true, activityId = null) {
    if (!Array.isArray(ids) || ids.length > 5 || (required && ids.length === 0) || new Set(ids).size !== ids.length)
      fail(400, '请上传 1—5 份证明材料')
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) fail(400, '证明材料编号无效')
      const file = db.prepare('SELECT * FROM proof_files WHERE id=?').get(id)
      const prior = file?.experience_id ? db.prepare('SELECT user_id,activity_id,status FROM experiences WHERE id=?').get(file.experience_id) : null
      const reusable = prior && activityId && prior.user_id === user.id && prior.activity_id === activityId && prior.status === 'rejected'
      if (!file || file.user_id !== user.id || (file.experience_id && !reusable) || (file.external_id && file.external_id !== externalId))
        fail(403, '证明材料不存在、不属于本人或已用于其他提交')
    }
  }
  function quota(userId, bytes) {
    const state = db.prepare('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM proof_files WHERE user_id=?').get(userId)
    if (state.n >= 100 || state.bytes + bytes > 50 * 1024 * 1024) fail(409, '个人材料容量已满，请联系管理员清理未使用材料')
  }
  function externalInput(input) {
    const text = key => typeof input[key] === 'string' ? input[key].trim() : ''
    const title = text('title'), organizer = text('organizer'), occurredOn = text('occurredOn'), description = text('description')
    const timestamp = Date.parse(occurredOn + 'T00:00:00+08:00')
    if (!title || title.length > 100 || !organizer || organizer.length > 100 || !description || description.length > 2000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn) || !Number.isFinite(timestamp) ||
      new Date(timestamp + 8 * 3600000).toISOString().slice(0,10) !== occurredOn ||
      occurredOn < '2000-01-01' || occurredOn > new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10) || !validHours(input.requestedHours))
      fail(400, '请填写活动名称、主办方、有效参加日期、学时和经历（日期不能在未来）')
    return { title, organizer, occurredOn, description, requestedHours: input.requestedHours }
  }
  function ownExternal(id, user) {
    const record = db.prepare('SELECT * FROM external_trainings WHERE id=? AND user_id=?').get(id, user.id)
    if (!record) fail(404, '自行提交的活动不存在')
    return record
  }
  function platformDuplicate(title, occurredOn, userId) {
    const start = Date.parse(occurredOn + 'T00:00:00+08:00')
    return db.prepare("SELECT a.id FROM activities a JOIN registrations r ON r.activity_id=a.id WHERE r.user_id=? AND a.title=? AND a.status='published' AND a.starts_at>=? AND a.starts_at<?").get(userId, title, start, start + 86400000)
  }
  return {
    combinedReviews(url) {
      const status = url.searchParams.get('status')
      if (status && !['pending','approved','rejected'].includes(status)) fail(400,'审核状态无效')
      const sql = `SELECT * FROM (
        SELECT 'experience:'||e.id id,e.id reviewId,0 external,e.title,e.description,e.status,e.credit_hours creditHours,e.review_note reviewNote,
          u.id userId,u.name,u.department,NULL organizer,NULL occurredOn,NULL requestedHours,e.created_at createdAt
        FROM experiences e JOIN users u ON e.user_id=u.id WHERE e.activity_id IS NOT NULL
        UNION ALL
        SELECT 'external:'||e.id,e.id,1,e.title,e.description,e.status,e.credited_hours,e.review_note,
          u.id,u.name,u.department,e.organizer,e.occurred_on,e.requested_hours,e.created_at
        FROM external_trainings e JOIN users u ON e.user_id=u.id
      )` + (status ? ' WHERE status=?' : '') + " ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,createdAt DESC,id DESC"
      const query = new URL(url)
      if (!query.searchParams.has('limit')) query.searchParams.set('limit','50')
      const result = pageQuery(db,sql,status ? [status] : [],query)
      const mapped = mapPage(result,row=>({ ...row,external:Boolean(row.external),proofs:proofList(db,row.external?'external_id':'experience_id',row.reviewId) }))
      const pendingCount = db.prepare("SELECT (SELECT COUNT(*) FROM experiences WHERE status='pending')+(SELECT COUNT(*) FROM external_trainings WHERE status='pending') n").get().n
      return { ...mapped,pendingCount }
    },
    preventDuplicateCredit(event, userId) {
      const date = new Date(event.starts_at + 8 * 3600000).toISOString().slice(0,10)
      if (db.prepare("SELECT id FROM external_trainings WHERE user_id=? AND title=? AND occurred_on=? AND status='approved'").get(userId, event.title, date))
        fail(409, '该活动已通过自行提交认定学时，请勿重复确认')
    },
    async upload(req, user, authorize) {
      if (user.role !== 'counselor') fail(403, '仅辅导员可上传证明材料')
      if (uploads >= 4) fail(429, '上传繁忙，请稍后重试')
      let name
      try { name = decodeURIComponent(req.headers['x-file-name'] || '') } catch { fail(400, '文件名格式错误') }
      if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) fail(400, '文件名无效')
      quota(user.id, 0)
      uploads++
      const id = crypto.randomBytes(24).toString('hex'), filePath = path.join(root, id)
      let written = false
      try {
        const buffer = await collectFile(req), mimeType = fileType(buffer)
        if (authorize().role !== 'counselor') fail(403, '账号角色已改变')
        quota(user.id, buffer.length)
        await fs.mkdir(root, { recursive: true })
        await fs.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 })
        written = true
        if (authorize().role !== 'counselor') fail(403, '账号角色已改变')
        quota(user.id, buffer.length)
        db.prepare('INSERT INTO proof_files(id,user_id,name,mime_type,bytes,created_at) VALUES(?,?,?,?,?,?)').run(id, user.id, name, mimeType, buffer.length, Date.now())
        return { id, name, mimeType, size: buffer.length }
      } catch (error) {
        if (written) await fs.unlink(filePath).catch(() => {})
        throw error
      } finally { uploads-- }
    },
    async download(id, user, authorize) {
      if (!/^[a-f0-9]{48}$/.test(id)) fail(404, '材料不存在')
      const file = db.prepare('SELECT * FROM proof_files WHERE id=?').get(id)
      if (!file || (user.role !== 'admin' && file.user_id !== user.id)) fail(404, '材料不存在')
      if(downloads>=4)fail(429,'材料下载繁忙，请稍后重试')
      downloads++
      try {
        let buffer
        try {
          const filePath=path.join(root,id),state=await fs.stat(filePath)
          if(!state.isFile()||state.size>MAX_FILE)fail(413,'材料文件异常，请联系管理员')
          buffer=await fs.readFile(filePath)
        } catch(error) { if(error.status)throw error;fail(404,'材料文件不存在，请联系管理员') }
        const current=authorize()
        if(current.role!=='admin'&&current.id!==file.user_id)fail(404,'材料不存在')
        let released=false
        const release=()=>{if(!released){released=true;downloads--}}
        return {buffer,name:file.name,mimeType:file.mime_type,release}
      } catch(error) { downloads--;throw error }
    },
    getExternal(id, user) {
      const record = ownExternal(id, user)
      return { id: record.id, title: record.title, organizer: record.organizer, occurredOn: record.occurred_on,
        requestedHours: record.requested_hours, description: record.description, status: record.status,
        creditHours: record.credited_hours, reviewNote: record.review_note, proofs: proofList(db, 'external_id', id) }
    },
    submitExternal(id, input, user) {
      if (user.role !== 'counselor') fail(403, '仅辅导员可提交培训活动')
      const form = externalInput(input)
      if (platformDuplicate(form.title, form.occurredOn, user.id)) fail(409, '该活动已在平台报名，请从活动记录提交经历')
      db.exec('BEGIN IMMEDIATE')
      try {
        if (id && ownExternal(id, user).status !== 'rejected') fail(409, '只有被驳回的活动可修改后重新提交')
        validateProofs(input.proofIds, user, id)
        const duplicate = db.prepare('SELECT id FROM external_trainings WHERE user_id=? AND title=? AND occurred_on=? AND id<>?').get(user.id, form.title, form.occurredOn, id || 0)
        if (duplicate) fail(409, '该活动已经提交，请勿重复申请学时')
        if (id) {
          db.prepare("UPDATE external_trainings SET title=?,organizer=?,occurred_on=?,requested_hours=?,description=?,status='pending',credited_hours=0,reviewed_by=NULL,reviewed_at=NULL,review_note='' WHERE id=?").run(form.title, form.organizer, form.occurredOn, form.requestedHours, form.description, id)
          db.prepare('UPDATE proof_files SET external_id=NULL WHERE external_id=?').run(id)
        } else {
          id = Number(db.prepare('INSERT INTO external_trainings(user_id,title,organizer,occurred_on,requested_hours,description,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id, form.title, form.organizer, form.occurredOn, form.requestedHours, form.description, Date.now()).lastInsertRowid)
        }
        for (const proofId of input.proofIds) db.prepare('UPDATE proof_files SET external_id=? WHERE id=?').run(id, proofId)
        db.exec('COMMIT')
        return { id, status: 'pending' }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    createExperience(event, user, description, proofIds = []) {
      db.exec('BEGIN IMMEDIATE')
      try {
        validateProofs(proofIds, user, null, false, event.id)
        const date = new Date(event.starts_at + 8 * 3600000).toISOString().slice(0,10)
        const result = db.prepare('INSERT INTO experiences(user_id,activity_id,title,organizer,occurred_on,description,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id, event.id, event.title, '平台活动', date, description, Date.now())
        const id = Number(result.lastInsertRowid)
        for (const proofId of proofIds) db.prepare('UPDATE proof_files SET experience_id=? WHERE id=?').run(id, proofId)
        db.exec('COMMIT')
        return { id, status: 'pending' }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    adminList(url) {
      const status = url?.searchParams.get('status')
      if (status && !['pending','approved','rejected'].includes(status)) fail(400,'审核状态无效')
      const result = pageQuery(db,'SELECT e.id,e.title,e.organizer,e.occurred_on occurredOn,e.requested_hours requestedHours,e.description,e.status,e.credited_hours creditHours,e.review_note reviewNote,u.id userId,u.name,u.department FROM external_trainings e JOIN users u ON e.user_id=u.id' + (status ? ' WHERE e.status=?' : '') + ' ORDER BY e.created_at DESC,e.id DESC',status ? [status] : [],url)
      return mapPage(result,record => ({ ...record,proofs:proofList(db,'external_id',record.id) }))
    },
    review(id, input, actor) {
      const status = input.status, note = typeof input.note === 'string' ? input.note.trim() : ''
      if (!['approved','rejected'].includes(status) || note.length > 500 || (status === 'rejected' && !note) || (status === 'approved' && !validHours(input.creditHours)))
        fail(400, '请填写审核结果、认定学时或驳回原因')
      const record = db.prepare('SELECT title,occurred_on,user_id FROM external_trainings WHERE id=?').get(id)
      if (status === 'approved' && record && platformDuplicate(record.title, record.occurred_on, record.user_id))
        fail(409, '该人员已报名同日同名的平台活动，请通过平台活动认定，避免重复计时')
      const result = db.prepare("UPDATE external_trainings SET status=?,credited_hours=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE id=? AND status='pending'").run(status, status === 'approved' ? input.creditHours : 0, actor.id, Date.now(), note, id)
      if (!result.changes) fail(409, '记录不存在或已审核')
      return { ok: true }
    },
  }
}
module.exports = { createEvidence, proofList }
