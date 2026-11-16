// 管理员统计共用查询口径，列表、下钻和导出使用同一组筛选条件。
const { pageQuery, boundedRows, EXPORT_LIMIT } = require('./pagination')

const DEPARTMENT_EMPTY = '未填写学院/部门'
const departmentSql = "COALESCE(NULLIF(TRIM(u.department),''),'" + DEPARTMENT_EMPTY + "')"
const dimensions = ['activity', 'counselor', 'department', 'ranking']
const labels = {
  activity: '活动参加情况',
  counselor: '辅导员参加情况',
  department: '学院参加情况',
  ranking: '年度学时排行',
}
const statusLabels = {
  approved: '已认定参加',
  pending: '待审核',
  unsubmitted: '未认定',
  rejected: '已驳回',
  cancelled: '活动已取消',
  withdrawn: '已取消报名',
}
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status })
}
const metrics = `COUNT(*) recordCount,
  SUM(reviewStatus='approved') attendedCount,
  SUM(reviewStatus IN ('pending','unsubmitted')) pendingCount,
  SUM(reviewStatus='rejected') rejectedCount,
  SUM(reviewStatus IN ('cancelled','withdrawn')) cancelledCount,
  ROUND(COALESCE(SUM(recognizedHours),0),2) totalHours,
  COUNT(DISTINCT userId) participantCount`
const selectedMetrics = [
  'recordCount',
  'attendedCount',
  'pendingCount',
  'rejectedCount',
  'cancelledCount',
  'totalHours',
  'participantCount',
]

function readOptions(input) {
  const url =
    input instanceof URL
      ? new URL(input)
      : new URL(input || 'http://localhost/api/admin/statistics')
  const dimension = url.searchParams.get('dimension') || 'activity'
  const year = url.searchParams.has('year')
    ? Number(url.searchParams.get('year'))
    : new Date(Date.now() + 28800000).getUTCFullYear()
  const q = (url.searchParams.get('q') || '').trim()
  const department = url.searchParams.get('department') || ''
  const key = url.searchParams.get('key')
  if (
    !dimensions.includes(dimension) ||
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100 ||
    q.length > 100 ||
    department.length > 100
  )
    fail(400, '统计维度、年份或筛选条件无效')
  if (key !== null) validateKey(dimension, key)
  if (!url.searchParams.has('limit')) url.searchParams.set('limit', '20')
  return { url, dimension, year, q, department, key }
}

function validateKey(dimension, key) {
  if (dimension === 'activity') {
    if (/^platform:[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key.slice(9)))) return
    if (key.startsWith('external:') && key.length <= 1024) {
      let values
      try {
        values = JSON.parse(key.slice(9))
      } catch {
        fail(400, '活动标识无效')
      }
      if (
        Array.isArray(values) &&
        values.length === 3 &&
        values.every((value) => typeof value === 'string') &&
        values[0].length > 0 &&
        values[0].length <= 100 &&
        values[1].length > 0 &&
        values[1].length <= 100 &&
        /^\d{4}-\d{2}-\d{2}$/.test(values[2]) &&
        key === 'external:' + JSON.stringify(values)
      )
        return
    }
    fail(400, '活动标识无效')
  }
  if (dimension === 'department') {
    if (!key || key.length > 100) fail(400, '学院标识无效')
  } else if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key)) fail(400, '辅导员工号无效')
}

function common(options) {
  const { year, dimension, department } = options
  const start = Date.parse(year + '-01-01T00:00:00+08:00'),
    end = Date.parse(year + 1 + '-01-01T00:00:00+08:00')
  const args = [start, end, year + '-01-01', year + 1 + '-01-01']
  const sql = `WITH raw_facts AS (
    SELECT 'platform:'||a.id||':'||u.id id,'platform:'||a.id activityKey,'platform' source,'平台活动' sourceLabel,
      a.title,a.location,'' organizer,a.starts_at startsAt,a.ends_at endsAt,a.credit_hours activityHours,
      u.id userId,u.name,${departmentSql} department,u.enabled,
      r.registered_at registeredAt,r.confirmed_at confirmedAt,r.cancelled_at withdrawnAt,
      (SELECT recorded_at FROM attendance_records ar WHERE ar.activity_id=a.id AND ar.user_id=u.id AND ar.phase='in') checkedInAt,
      (SELECT recorded_at FROM attendance_records ar WHERE ar.activity_id=a.id AND ar.user_id=u.id AND ar.phase='out') checkedOutAt,
      CASE WHEN a.status='cancelled' THEN 'cancelled' WHEN r.cancelled_at IS NOT NULL THEN 'withdrawn'
        WHEN r.confirmed_at IS NOT NULL THEN 'approved' WHEN e.status='rejected' THEN 'rejected'
        WHEN e.status='pending' THEN 'pending' ELSE 'unsubmitted' END reviewStatus,
      CASE WHEN a.status='published' AND r.cancelled_at IS NULL AND r.confirmed_at IS NOT NULL THEN r.credited_hours ELSE 0 END recognizedHours,
      COALESCE(e.description,'') experience,COALESCE(e.review_note,'') reviewNote
    FROM registrations r JOIN activities a ON a.id=r.activity_id JOIN users u ON u.id=r.user_id
    LEFT JOIN experiences e ON e.id=(SELECT latest.id FROM experiences latest WHERE latest.user_id=r.user_id AND latest.activity_id=a.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
    WHERE u.role='counselor' AND a.starts_at>=? AND a.starts_at<?
    UNION ALL
    SELECT 'external:'||e.id,'external:'||json_array(e.title,e.organizer,e.occurred_on),'external','自行培训',
      e.title,e.organizer,e.organizer,CAST(strftime('%s',e.occurred_on||' 00:00:00','-8 hours') AS INTEGER)*1000,
      CAST(strftime('%s',e.occurred_on||' 00:00:00','-8 hours') AS INTEGER)*1000,e.requested_hours,
      u.id,u.name,${departmentSql},u.enabled,e.created_at,CASE WHEN e.status='approved' THEN e.reviewed_at ELSE NULL END,NULL,NULL,NULL,
      e.status,CASE WHEN e.status='approved' THEN e.credited_hours ELSE 0 END,e.description,e.review_note
    FROM external_trainings e JOIN users u ON u.id=e.user_id
    WHERE u.role='counselor' AND e.occurred_on>=? AND e.occurred_on<?
  ), facts AS (SELECT * FROM raw_facts${department && dimension !== 'ranking' ? ' WHERE department=?' : ''})`
  if (department && dimension !== 'ranking') args.push(department)
  return { sql, args, start, end }
}

function summaryQuery(options) {
  const base = common(options),
    { dimension, department, q, key } = options
  let sql = base.sql
  const args = [...base.args]
  const fields = selectedMetrics.map((field) => `COALESCE(g.${field},0) ${field}`).join(',')
  if (dimension === 'activity') {
    sql += `, aggregates AS (SELECT activityKey,${metrics} FROM facts GROUP BY activityKey), catalog AS (
      SELECT 'platform:'||id key,title name,'平台活动' sourceLabel,starts_at startsAt,location,status,credit_hours creditHours,'' department FROM activities WHERE starts_at>=? AND starts_at<?
      UNION ALL SELECT activityKey,title,'自行培训',MIN(startsAt),organizer,'submitted',NULL,'' FROM facts WHERE source='external' GROUP BY activityKey
    ), grouped AS (SELECT c.*,${fields} FROM catalog c LEFT JOIN aggregates g ON g.activityKey=c.key)`
    args.push(base.start, base.end)
  } else if (dimension === 'department') {
    sql += `, aggregates AS (SELECT department,${metrics} FROM facts GROUP BY department), catalog AS (
      SELECT ${departmentSql} key,COUNT(*) counselorCount FROM users u WHERE u.role='counselor' GROUP BY ${departmentSql}
    ), grouped AS (SELECT c.key,c.key name,c.key department,c.counselorCount,${fields} FROM catalog c LEFT JOIN aggregates g ON g.department=c.key)`
  } else {
    sql += `, aggregates AS (SELECT userId,${metrics} FROM facts GROUP BY userId), grouped AS (
      SELECT u.id key,u.id id,u.name,${departmentSql} department,u.enabled,${fields}
      FROM users u LEFT JOIN aggregates g ON g.userId=u.id WHERE u.role='counselor'
    )`
    if (dimension === 'ranking')
      sql += ', ranked AS (SELECT *,RANK() OVER(ORDER BY totalHours DESC) rank FROM grouped)'
  }
  const conditions = []
  if (department && dimension === 'department') {
    conditions.push('key=?')
    args.push(department)
  }
  if (department && ['counselor', 'ranking'].includes(dimension)) {
    conditions.push('department=?')
    args.push(department)
  }
  if (q) {
    if (dimension === 'activity')
      conditions.push('(instr(lower(name),lower(?))>0 OR instr(lower(location),lower(?))>0)')
    else
      conditions.push(
        '(instr(lower(name),lower(?))>0 OR instr(lower(department),lower(?))>0' +
          (dimension === 'department' ? '' : ' OR instr(lower(key),lower(?))>0') +
          ')',
      )
    args.push(q, q)
    if (!['activity', 'department'].includes(dimension)) args.push(q)
  }
  if (key !== null) {
    conditions.push('key=?')
    args.push(key)
  }
  sql +=
    ' SELECT * FROM ' +
    (dimension === 'ranking' ? 'ranked' : 'grouped') +
    (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '')
  return { sql, args }
}

function orderFor(dimension) {
  if (dimension === 'activity') return ' ORDER BY startsAt DESC,key'
  if (dimension === 'ranking') return ' ORDER BY totalHours DESC,key'
  return ' ORDER BY totalHours DESC,name,key'
}

function recordsQuery(options, summary) {
  const base = common(options)
  // Both statements are self-contained CTE subqueries, keeping all values parameterized.
  const groupField =
    options.dimension === 'activity'
      ? 'activityKey'
      : options.dimension === 'department'
        ? 'department'
        : 'userId'
  return {
    sql: `SELECT f.* FROM (${base.sql} SELECT * FROM facts) f JOIN (${summary.sql}) chosen ON chosen.key=f.${groupField}`,
    args: [...base.args, ...summary.args],
  }
}

function recordDto(row) {
  return {
    ...row,
    key: row.id,
    statusLabel: statusLabels[row.reviewStatus] || row.reviewStatus,
    recognizedHours: Math.round(row.recognizedHours * 100) / 100,
  }
}

function createStatistics(db) {
  function selected(options) {
    const query = summaryQuery(options)
    if (
      options.key !== null &&
      !db.prepare('SELECT 1 FROM (' + query.sql + ') LIMIT 1').get(...query.args)
    )
      fail(404, '所选统计分组不存在，请刷新列表')
    return query
  }
  return {
    summary(input) {
      const options = readOptions(input),
        query = selected(options)
      const result = pageQuery(db, query.sql + orderFor(options.dimension), query.args, options.url)
      const totals = db
        .prepare(
          `SELECT COUNT(*) groupCount,COALESCE(SUM(recordCount),0) recordCount,
        COALESCE(SUM(attendedCount),0) attendedCount,COALESCE(SUM(pendingCount),0) pendingCount,
        COALESCE(SUM(rejectedCount),0) rejectedCount,COALESCE(SUM(cancelledCount),0) cancelledCount,
        ROUND(COALESCE(SUM(totalHours),0),2) totalHours FROM (${query.sql})`,
        )
        .get(...query.args)
      return { dimension: options.dimension, year: options.year, ...result, totals }
    },
    records(input) {
      const options = readOptions(input),
        chosen = selected(options),
        query = recordsQuery(options, chosen)
      const result = pageQuery(
        db,
        query.sql + ' ORDER BY startsAt DESC,title,userId,id',
        query.args,
        options.url,
      )
      return {
        dimension: options.dimension,
        year: options.year,
        ...result,
        rows: result.rows.map(recordDto),
      }
    },
    exportSheets(input) {
      const options = readOptions(input),
        chosen = selected(options)
      const groups = boundedRows(
        db,
        chosen.sql + orderFor(options.dimension),
        chosen.args,
        EXPORT_LIMIT,
        true,
      )
      const detail = recordsQuery(options, chosen)
      const records = boundedRows(
        db,
        detail.sql + ' ORDER BY startsAt DESC,title,userId,id',
        detail.args,
        EXPORT_LIMIT - groups.length,
        true,
      ).map(recordDto)
      let identity
      if (options.dimension === 'activity')
        identity = [
          { header: '活动名称', key: 'name', width: 36 },
          { header: '来源', key: 'sourceLabel', width: 16 },
          {
            header: '活动时间（北京时间）',
            key: 'activityDate',
            width: 26,
            style: { numFmt: 'yyyy-mm-dd hh:mm' },
          },
          { header: '地点 / 主办方', key: 'location', width: 28 },
        ]
      else if (options.dimension === 'department')
        identity = [
          { header: '学院 / 部门', key: 'name', width: 28 },
          { header: '辅导员人数', key: 'counselorCount', width: 18 },
        ]
      else
        identity = [
          ...(options.dimension === 'ranking'
            ? [{ header: '年度排名', key: 'rank', width: 12 }]
            : []),
          { header: '工号', key: 'key', width: 20 },
          { header: '姓名', key: 'name', width: 18 },
          { header: '学院 / 部门', key: 'department', width: 28 },
        ]
      const countColumns = [
        { header: '报名 / 提交记录数', key: 'recordCount', width: 23 },
        { header: '已认定参加', key: 'attendedCount', width: 18 },
        { header: '待认定 / 待审核', key: 'pendingCount', width: 23 },
        { header: '已驳回', key: 'rejectedCount', width: 14 },
        { header: '取消记录数', key: 'cancelledCount', width: 18 },
        { header: '认定学时', key: 'totalHours', width: 16 },
      ]
      const sheets = [
        {
          name: labels[options.dimension],
          columns: [...identity, ...countColumns],
          rows: groups.map((row) => ({
            ...row,
            activityDate: row.startsAt ? new Date(row.startsAt + 28800000) : null,
          })),
        },
        {
          name: '参加明细',
          columns: [
            { header: '工号', key: 'userId', width: 20 },
            { header: '姓名', key: 'name', width: 18 },
            { header: '学院 / 部门', key: 'department', width: 28 },
            { header: '活动名称', key: 'title', width: 36 },
            { header: '活动来源', key: 'sourceLabel', width: 16 },
            {
              header: '活动时间（北京时间）',
              key: 'activityDate',
              width: 26,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
            { header: '参加状态', key: 'statusLabel', width: 18 },
            { header: '认定学时', key: 'recognizedHours', width: 16 },
            {
              header: '签到时间（北京时间）',
              key: 'checkInDate',
              width: 26,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
            {
              header: '签退时间（北京时间）',
              key: 'checkOutDate',
              width: 26,
              style: { numFmt: 'yyyy-mm-dd hh:mm' },
            },
            { header: '培训经历', key: 'experience', width: 50 },
            { header: '审核意见', key: 'reviewNote', width: 40 },
          ],
          rows: records.map((row) => ({
            ...row,
            activityDate: new Date(row.startsAt + 28800000),
            checkInDate: row.checkedInAt ? new Date(row.checkedInAt + 28800000) : null,
            checkOutDate: row.checkedOutAt ? new Date(row.checkedOutAt + 28800000) : null,
          })),
        },
      ]
      return { filename: options.year + '-' + labels[options.dimension] + '.xlsx', sheets }
    },
  }
}

module.exports = { createStatistics }
