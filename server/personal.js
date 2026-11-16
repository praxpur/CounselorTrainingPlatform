// 合并平台活动与自行培训，统一个人记录状态、已认定学时和年度汇总。
const { proofList } = require('./evidence')
const { pageQuery } = require('./pagination')

function recordQuery(userId, { year, filter = 'all' } = {}) {
  const sql = `SELECT *,CASE WHEN reviewStatus='approved' THEN creditedHours ELSE 0 END recognizedHours FROM (
    SELECT a.id,NULL externalId,0 external,a.title,a.location,a.status,a.starts_at startsAt,a.ends_at endsAt,
      a.credit_hours creditHours,r.registered_at registeredAt,r.cancelled_at withdrawnAt,r.confirmed_at confirmedAt,r.credited_hours creditedHours,
      e.id experienceId,e.description experience,e.status experienceStatus,e.review_note reviewNote,e.reviewed_at reviewedAt,
      CASE WHEN a.status='cancelled' THEN 'cancelled' WHEN r.cancelled_at IS NOT NULL THEN 'withdrawn' WHEN r.confirmed_at IS NOT NULL THEN 'approved'
        WHEN e.status='rejected' THEN 'rejected' WHEN e.status='pending' THEN 'pending' ELSE 'unsubmitted' END reviewStatus
    FROM registrations r JOIN activities a ON a.id=r.activity_id
    LEFT JOIN experiences e ON e.id=(SELECT latest.id FROM experiences latest
      WHERE latest.user_id=r.user_id AND latest.activity_id=r.activity_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
    WHERE r.user_id=?
    UNION ALL
    SELECT 'external:'||id,id,1,title,organizer,'published',
      CAST(strftime('%s',occurred_on||' 00:00:00','-8 hours') AS INTEGER)*1000,
      CAST(strftime('%s',occurred_on||' 00:00:00','-8 hours') AS INTEGER)*1000,
      requested_hours,NULL,NULL,CASE WHEN status='approved' THEN reviewed_at ELSE NULL END,credited_hours,
      NULL,description,status,review_note,reviewed_at,status
    FROM external_trainings WHERE user_id=?
  )`
  const conditions = [],
    args = [userId, userId]
  if (year !== undefined) {
    conditions.push('startsAt>=? AND startsAt<?')
    args.push(
      Date.parse(year + '-01-01T00:00:00+08:00'),
      Date.parse(year + 1 + '-01-01T00:00:00+08:00'),
    )
  }
  const filters = {
    all: '',
    pending: "reviewStatus IN ('pending','unsubmitted')",
    reviewed: "reviewStatus IN ('approved','rejected')",
    cancelled: "reviewStatus IN ('cancelled','withdrawn')",
  }
  if (!Object.hasOwn(filters, filter))
    throw Object.assign(new Error('记录筛选无效'), { status: 400 })
  if (filters[filter]) conditions.push(filters[filter])
  return { sql: sql + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''), args }
}
function decorate(db, record) {
  return {
    ...record,
    external: Boolean(record.external),
    reviewLabel: {
      approved: record.external ? '已审核通过' : '已确认参加',
      rejected: '已驳回',
      pending: '待审核',
      unsubmitted: '待确认参加',
      cancelled: '活动已取消',
      withdrawn: '已取消报名',
    }[record.reviewStatus],
    canSubmit: Boolean(record.external) && record.reviewStatus === 'rejected',
    proofs: proofList(
      db,
      record.external ? 'external_id' : 'experience_id',
      record.external ? record.externalId : record.experienceId,
    ),
  }
}
function personalRecords(db, userId, options = {}) {
  const filter = options.url?.searchParams.get('filter') || 'all'
  const { sql, args } = recordQuery(userId, { year: options.year, filter })
  const result = pageQuery(db, sql + ' ORDER BY startsAt DESC,id DESC', args, options.url, options)
  return Array.isArray(result)
    ? result.map((row) => decorate(db, row))
    : { ...result, rows: result.rows.map((row) => decorate(db, row)) }
}
function personalAnnual(db, userId, year, options = {}) {
  const { sql, args } = recordQuery(userId, { year })
  const summary = db
    .prepare(
      `SELECT COUNT(*) activityCount,COALESCE(ROUND(SUM(recognizedHours),2),0) totalHours,
    COALESCE(SUM(reviewStatus='approved'),0) approvedCount,COALESCE(SUM(reviewStatus IN ('pending','unsubmitted')),0) pendingCount,
    COALESCE(SUM(reviewStatus='rejected'),0) rejectedCount,COALESCE(SUM(reviewStatus IN ('cancelled','withdrawn')),0) cancelledCount FROM (${sql})`,
    )
    .get(...args)
  const monthRows = db
    .prepare(
      `SELECT CAST(strftime('%m',startsAt/1000+28800,'unixepoch') AS INTEGER) month,
    ROUND(SUM(recognizedHours),2) hours FROM (${sql}) GROUP BY month`,
    )
    .all(...args)
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    hours: monthRows.find((row) => row.month === index + 1)?.hours || 0,
  }))
  const data = personalRecords(db, userId, { ...options, year })
  return {
    year,
    ...summary,
    months,
    records: Array.isArray(data) ? data : data.rows,
    ...(Array.isArray(data)
      ? {}
      : { total: data.total, hasMore: data.hasMore, nextOffset: data.nextOffset }),
  }
}
module.exports = { personalRecords, personalAnnual, recordQuery }
