// CSV 保留字符串和前导零；支持引号、逗号及引号内换行。
function parseRosterCsv(text) {
  const rows = [], row = []
  let field = '', quoted = false, closed = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i <= text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') { quoted = false; closed = true }
      else if (char === undefined) throw new Error('CSV 引号未闭合')
      else field += char
    } else if (char === '"' && !field && !closed) {
      quoted = true
    } else if (char === ',' || char === '\r' || char === '\n' || char === undefined) {
      row.push(field); field = ''; closed = false
      if (char !== ',') {
        if (row.some(value => value !== '')) rows.push(row.splice(0))
        else row.length = 0
        if (char === '\r' && text[i + 1] === '\n') i++
      }
    } else {
      if (closed || char === '"') throw new Error('CSV 引号格式错误')
      field += char
    }
  }
  const headers = rows.shift() || []
  const keys = ['工号', '姓名', '学院/部门', '初始密码']
  if (headers.length !== 4 || !keys.every((key, index) => headers[index].trim() === key))
    throw new Error('CSV 表头须为：工号,姓名,学院/部门,初始密码')
  if (!rows.length || rows.length > 500) throw new Error('每个文件须包含 1—500 人')
  return rows.map((values, index) => {
    if (values.length !== 4) throw new Error('第 ' + (index + 2) + ' 行列数错误')
    return { id: values[0].trim(), name: values[1].trim(), department: values[2].trim(), initialPassword: values[3] }
  })
}
module.exports = { parseRosterCsv }
