const { AsyncLocalStorage } = require('node:async_hooks')
const crypto = require('node:crypto')

function createAudit(db) {
  const context = new AsyncLocalStorage(), systemRequest = 'system:' + crypto.randomUUID()
  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs(
    id INTEGER PRIMARY KEY,happened_at INTEGER NOT NULL,actor_id TEXT NOT NULL,
    action TEXT NOT NULL,target TEXT NOT NULL,outcome TEXT NOT NULL,detail TEXT NOT NULL,request_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_time ON audit_logs(happened_at,id);
    CREATE INDEX IF NOT EXISTS audit_actor_index ON audit_logs(actor_id,id);
    CREATE INDEX IF NOT EXISTS audit_action_index ON audit_logs(action,id);`)
  db.function('audit_actor', () => context.getStore()?.authenticatedUser || context.getStore()?.auditAccount || 'system')
  db.function('audit_request', () => context.getStore()?.auditId || systemRequest)
  db.function('audit_now', () => Date.now())

  // 字段白名单固定在代码中；凭据哈希、Token、文件内容不进入审计表。
  const tables = [
    ['users', ['id','name','department','role','enabled'], row => row + '.id'],
    ['activities', ['title','description','location','starts_at','ends_at','capacity','credit_hours','status'], row => row + '.id'],
    ['registrations', ['activity_id','user_id','registered_at','cancelled_at','confirmed_at','confirmed_by','credited_hours'], row => row + ".activity_id || ':' || " + row + '.user_id'],
    ['experiences', ['user_id','activity_id','title','description','status','credit_hours','reviewed_by','reviewed_at','review_note'], row => row + '.id'],
    ['external_trainings', ['user_id','title','organizer','occurred_on','requested_hours','description','status','credited_hours','reviewed_by','reviewed_at','review_note'], row => row + '.id'],
    ['credentials', ['user_id','must_change'], row => row + '.user_id'],
    ['sessions', ['user_id','expires'], row => row + '.user_id'],
    ['proof_files', ['user_id','name','mime_type','bytes','external_id','experience_id','ever_submitted'], row => row + '.id'],
    ['attendance_sessions', ['activity_id','phase','method','opens_at','closes_at','latitude','longitude','radius','created_by'], row => row + ".activity_id || ':' || " + row + '.phase'],
    ['attendance_records', ['activity_id','user_id','phase','method','recorded_at','distance','accuracy'], row => row + ".activity_id || ':' || " + row + ".user_id || ':' || " + row + '.phase'],
    ['notification_events',['kind','target','created_at'],row=>row+'.id'],
    ['notifications',['user_id','event_id','kind','title','body','target_type','target_id','created_at','read_at'],row=>row+'.id'],
  ]
  // 刷新触发器必须在单个写事务内，其他进程不能遇到无审计的空窗。
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [table, fields, target] of tables) {
      const snapshot = row => 'json_object(' + fields.map(field => "'" + field + "'," + row + '.' + field).join(',') + ')'
      for (const operation of ['INSERT','UPDATE','DELETE']) {
        const before = operation === 'INSERT' ? 'NULL' : snapshot('OLD')
        const after = operation === 'DELETE' ? 'NULL' : snapshot('NEW')
        // 所有 SQL 标识符来自上面的静态白名单。
        db.exec(`DROP TRIGGER IF EXISTS audit_${table}_${operation.toLowerCase()}; CREATE TRIGGER audit_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          BEGIN INSERT INTO audit_logs(happened_at,actor_id,action,target,outcome,detail,request_id)
          VALUES(audit_now(),audit_actor(),'${table}.${operation.toLowerCase()}',CAST(${target(operation === 'DELETE' ? 'OLD' : 'NEW')} AS TEXT),'success',json_object('before',${before},'after',${after}),audit_request()); END;`)
      }
    }
    db.exec('COMMIT')
  } catch(error) { db.exec('ROLLBACK');throw error }
  function record(req, action, target, status) {
    db.prepare('INSERT INTO audit_logs(happened_at,actor_id,action,target,outcome,detail,request_id) VALUES(?,?,?,?,?,?,?)').run(
      Date.now(), req.authenticatedUser || (status < 400 ? req.auditAccount : null) || 'anonymous', action, target,
      status >= 400 ? 'failure' : 'success', JSON.stringify({ status, method: req.method }), req.auditId,
    )
  }
  function requestAction(req) {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return { action: 'request.invalid', target: 'invalid' } }
    const path = url.pathname
    if (path.startsWith('/api/auth/')) return { action: 'auth.' + (path.split('/').pop() === 'password' ? 'password.change' : 'login'), target: req.auditAccount || req.authenticatedUser || 'unknown' }
    if (path.includes('/exports/')) {
      const year = url.searchParams.get('year')
      return { action: 'data.export', target: path + (year ? '?year=' + (/^\d{4}$/.test(year) ? year : 'invalid') : '') }
    }
    if (path === '/api/admin/audit-logs') return { action: 'audit.read', target: 'audit-logs' }
    if (/^\/api\/proofs\/[a-f0-9]{48}$/.test(path)) return { action: 'proof.download', target: path.split('/').pop() }
    if (req.method !== 'GET' && path.startsWith('/api/')) {
      const known = /^\/api\/(?:(?:admin\/)?(?:activities|users|experiences)(?:\/[a-zA-Z0-9_-]{1,40})?(?:\/(?:register|cancel|confirm|review|password|attendance)(?:\/(?:in|out))?)?|my\/external-trainings(?:\/\d+)?|admin\/external-trainings\/\d+\/review|notifications\/(?:read-all|[1-9]\d*\/read)|proofs|logout)$/.test(path)
      return { action: 'request.write', target: known ? path : 'unknown-endpoint' }
    }
    return null
  }
  return {
    run(req, res, handler) {
      req.auditId = crypto.randomUUID()
      res.setHeader('X-Request-Id', req.auditId)
      let recorded = false
      const finish = status => {
        if (recorded) return
        recorded = true
        const event = requestAction(req) || (status >= 400 ? { action: 'request.denied', target: 'protected-resource' } : null)
        if (event) {
          try { record(req, event.action, event.target, status) }
          catch { console.error('Audit request record failed; requestId=' + req.auditId) }
        }
      }
      res.once('finish', () => finish(res.statusCode))
      res.once('close', () => { if (!res.writableFinished) finish(499) })
      return context.run(req, handler)
    },
    list(url) {
      const limit = Number(url.searchParams.get('limit') || 50), before = url.searchParams.get('before')
      const actor = url.searchParams.get('actor') || '', action = url.searchParams.get('action') || ''
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before && (!/^[1-9]\d{0,15}$/.test(before) || !Number.isSafeInteger(Number(before)))) ||
        actor.length > 40 || action.length > 80)
        throw Object.assign(new Error('审计查询参数无效'), { status: 400 })
      const filters = [], args = []
      if (before) { filters.push('id<?'); args.push(Number(before)) }
      if (actor) { filters.push('actor_id=?'); args.push(actor) }
      if (action) { filters.push('action=?'); args.push(action) }
      const rows = db.prepare('SELECT id,happened_at happenedAt,actor_id actorId,action,target,outcome,detail,request_id requestId FROM audit_logs' + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?').all(...args, limit + 1)
      const hasMore = rows.length > limit, visible = rows.slice(0,limit)
      return { rows: visible.map(row => ({ ...row, detail: JSON.parse(row.detail) })), hasMore, nextCursor: hasMore ? visible.at(-1).id : null }
    },
  }
}
module.exports = { createAudit }
