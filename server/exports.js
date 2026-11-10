const ExcelJS = require('exceljs')

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name)
  sheet.columns = columns
  sheet.addRows(rows)
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
  sheet.getRow(1).height = 28
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { name: '微软雅黑', bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25489C' } }
  })
  sheet.eachRow((row, index) => {
    if (index === 1) return
    row.eachCell((cell) => {
      cell.font = { name: '微软雅黑', size: 11 }
      cell.alignment = { vertical: 'top', wrapText: true }
    })
  })
  return sheet
}

async function sendWorkbook(res, filename, sheets) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '济南大学学生工作处'
  for (const sheet of sheets) addSheet(workbook, sheet.name, sheet.columns, sheet.rows)
  const buffer = await workbook.xlsx.writeBuffer()
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    'Cache-Control': 'no-store',
    'Content-Length': buffer.length,
  })
  res.end(buffer)
}

module.exports = { sendWorkbook }
