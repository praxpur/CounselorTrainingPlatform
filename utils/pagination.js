const PAGE_SIZE = 20
const MAX_VISIBLE_ROWS = 100
const MAX_VISIBLE_JSON_LENGTH = 100000

function pagePath(path, offset = 0, limit = PAGE_SIZE) {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}limit=${limit}&offset=${offset}`
}

function readPage(result, key = 'rows') {
  if (
    !result ||
    Array.isArray(result) ||
    !Array.isArray(result[key]) ||
    typeof result.hasMore !== 'boolean'
  ) {
    throw new Error('列表响应格式错误，请刷新重试')
  }

  return {
    rows: result[key],
    total: result.total ?? result[key].length,
    hasMore: result.hasMore,
    nextOffset: result.nextOffset ?? null,
  }
}

// 更新请求编号，让这个列表尚未完成的旧请求失效。
function cancelList(owner, field) {
  const key = '_listEpoch_' + field
  owner[key] = (owner[key] || 0) + 1
}

// owner 是小程序页面实例，field 是列表在 owner.data 中的字段名。
async function loadList(owner, api, options) {
  if (!api.guard()) return

  const {
    path,
    field,
    map = (value) => value,
    rowsKey = 'rows',
    after = () => ({}),
    prefix = '',
    start = {},
  } = options

  // append 为 true 时追加下一页；为 { pageOffset } 时替换为指定页。
  const append = options.append === true
  const pageOffset = options.append?.pageOffset
  const hasExplicitOffset = Number.isInteger(pageOffset) && pageOffset >= 0

  // prefix 用来区分同一页面中不同列表的分页状态。
  const moreKey = prefix ? prefix + 'HasMore' : 'hasMore'
  const offsetKey = prefix ? prefix + 'NextOffset' : 'nextOffset'
  const totalKey = prefix ? prefix + 'Total' : 'total'
  const previousKey = prefix ? prefix + 'PreviousOffset' : 'previousOffset'
  const windowKey = prefix ? prefix + 'Windowed' : 'windowed'
  const fromKey = prefix ? prefix + 'DisplayFrom' : 'displayFrom'
  const toKey = prefix ? prefix + 'DisplayTo' : 'displayTo'

  if (append && (owner.data.loading || !owner.data[moreKey])) return

  let offset = 0
  if (hasExplicitOffset) {
    offset = pageOffset
  } else if (append) {
    offset = owner.data[offsetKey]
  }

  cancelList(owner, field)
  const epochKey = '_listEpoch_' + field
  const requestEpoch = owner[epochKey]

  // 追加时保留现有数据；重新加载或跳页时清空列表及分页状态。
  owner.setData({
    loading: true,
    errorMessage: '',
    ...(append ? {} : {
      [field]: [],
      [moreKey]: false,
      [offsetKey]: null,
      [totalKey]: 0,
      [previousKey]: null,
      [windowKey]: false,
      [fromKey]: 0,
      [toKey]: 0,
      ...start,
    }),
  })

  try {
    const result = await api.request(pagePath(path, offset || 0))
    if (requestEpoch !== owner[epochKey]) return

    const page = readPage(result, rowsKey)
    const incoming = page.rows.map(map)
    let rows = append ? [...owner.data[field], ...incoming] : incoming
    let firstIndex = append ? (owner.data[fromKey] || 1) - 1 : offset

    // 列表条数或序列化长度超限时，只保留本次返回的一页。
    const exceedsDisplayLimit = rows.length > MAX_VISIBLE_ROWS ||
      JSON.stringify(rows).length > MAX_VISIBLE_JSON_LENGTH
    if (exceedsDisplayLimit) {
      rows = incoming
      firstIndex = offset
    }

    owner.setData({
      [field]: rows,
      [moreKey]: page.hasMore,
      [offsetKey]: page.nextOffset,
      [totalKey]: page.total,
      [previousKey]: offset > 0 ? Math.max(0, offset - PAGE_SIZE) : null,
      [windowKey]: exceedsDisplayLimit || firstIndex > 0,
      [fromKey]: rows.length ? firstIndex + 1 : 0,
      [toKey]: firstIndex + rows.length,
      ...after(result, rows),
    })
    return result
  } catch (error) {
    if (requestEpoch === owner[epochKey]) {
      owner.setData({ errorMessage: error.message })
      api.error(error)
    }
  } finally {
    // 旧请求结束时，不修改新请求的加载状态。
    if (requestEpoch === owner[epochKey]) {
      owner.setData({ loading: false })
    }
  }
}

module.exports = { pagePath, readPage, loadList, cancelList }
