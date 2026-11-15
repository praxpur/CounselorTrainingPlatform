const LEGACY_LIMIT = 2000
const EXPORT_LIMIT = 10000
function bad(message, status = 400) { throw Object.assign(new Error(message), { status }) }
function pageOptions(url) {
  if (!url || (!url.searchParams.has('limit') && !url.searchParams.has('offset'))) return null
  const limit = Number(url.searchParams.get('limit') || 50), offset = Number(url.searchParams.get('offset') || 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000)
    bad('分页参数无效：每页 1—100 条，偏移量须为非负整数')
  return { limit, offset }
}
function boundedRows(db, sql, args = [], limit = LEGACY_LIMIT, exporting = false) {
  const rows = db.prepare('SELECT * FROM (' + sql + ') LIMIT ?').all(...args, limit + 1)
  if (rows.length > limit) bad(exporting ? '导出数据过多，请按年份或人员分批导出' : '数据较多，请使用分页读取', exporting ? 413 : 400)
  return rows
}
function pageQuery(db, sql, args = [], url, options = {}) {
  if (options.exporting) return boundedRows(db, sql, args, EXPORT_LIMIT, true)
  const page = pageOptions(url)
  if (!page) return boundedRows(db, sql, args)
  const total = db.prepare('SELECT COUNT(*) total FROM (' + sql + ')').get(...args).total
  const rows = db.prepare('SELECT * FROM (' + sql + ') LIMIT ? OFFSET ?').all(...args, page.limit, page.offset)
  const hasMore = page.offset + rows.length < total
  return { rows, total, hasMore, nextOffset: hasMore ? page.offset + rows.length : null }
}
function mapPage(result, mapper) {
  return Array.isArray(result) ? result.map(mapper) : { ...result, rows: result.rows.map(mapper) }
}
module.exports = { pageQuery, pageOptions, mapPage, boundedRows, EXPORT_LIMIT }
