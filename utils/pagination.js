const PAGE_SIZE = 20
function pagePath(path, offset = 0, limit = PAGE_SIZE) {
  return path + (path.includes('?') ? '&' : '?') + 'limit=' + limit + '&offset=' + offset
}
function readPage(result, key = 'rows', offset = 0) {
  // 支持前后端滚动升级期间的旧数组响应。
  if (Array.isArray(result)) {
    const rows=result.slice(offset,offset+PAGE_SIZE),hasMore=offset+rows.length<result.length
    return {rows,total:result.length,hasMore,nextOffset:hasMore?offset+rows.length:null}
  }
  if (!result || !Array.isArray(result[key])) throw new Error('列表响应格式错误，请刷新重试')
  if(result.hasMore===undefined)return readPage(result[key],key,offset)
  return { rows: result[key], total: result.total ?? result[key].length, hasMore: Boolean(result.hasMore), nextOffset: result.nextOffset ?? null }
}
function cancelList(owner, field) {
  const key = '_listEpoch_' + field
  owner[key] = (owner[key] || 0) + 1
}
async function loadList(owner, api, options) {
  if (!api.guard()) return
  const { path, field, map = value => value, rowsKey = 'rows', after = () => ({}), prefix = '', start = {} } = options
  const append = options.append === true
  const moreKey = prefix ? prefix + 'HasMore' : 'hasMore'
  const offsetKey = prefix ? prefix + 'NextOffset' : 'nextOffset'
  const totalKey = prefix ? prefix + 'Total' : 'total'
  const previousKey=prefix?prefix+'PreviousOffset':'previousOffset'
  const windowKey=prefix?prefix+'Windowed':'windowed'
  const fromKey=prefix?prefix+'DisplayFrom':'displayFrom'
  const toKey=prefix?prefix+'DisplayTo':'displayTo'
  const explicit=Number.isInteger(options.append?.pageOffset)&&options.append.pageOffset>=0?options.append.pageOffset:null
  if (append && (owner.data.loading || !owner.data[moreKey])) return
  cancelList(owner, field)
  const epoch = owner['_listEpoch_' + field], offset = explicit!==null?explicit:append?owner.data[offsetKey]:0
  owner.setData({ loading: true, errorMessage: '', ...(append ? {} : { [field]: [], [moreKey]: false, [offsetKey]: null, [totalKey]: 0,
    [previousKey]:null,[windowKey]:false,[fromKey]:0,[toKey]:0,...start }) })
  try {
    const result = await api.request(pagePath(path, offset || 0))
    if (epoch !== owner['_listEpoch_' + field]) return
    const page = readPage(result, rowsKey,offset||0),incoming=page.rows.map(map)
    let rows=append?[...owner.data[field],...incoming]:incoming
    const windowed=rows.length>100||JSON.stringify(rows).length>100000
    let first=append?(owner.data[fromKey]||1)-1:offset
    if(windowed){rows=incoming;first=offset}
    owner.setData({ [field]:rows,[moreKey]:page.hasMore,[offsetKey]:page.nextOffset,[totalKey]:page.total,
      [previousKey]:offset>0?Math.max(0,offset-PAGE_SIZE):null,[windowKey]:windowed||first>0,
      [fromKey]:rows.length?first+1:0,[toKey]:first+rows.length,...after(result,rows) })
    return result
  } catch (error) {
    if (epoch === owner['_listEpoch_' + field]) { owner.setData({ errorMessage: error.message }); api.error(error) }
  } finally {
    if (epoch === owner['_listEpoch_' + field]) owner.setData({ loading: false })
  }
}
module.exports = { pagePath, readPage, loadList, cancelList }
