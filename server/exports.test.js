const { test } = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { sendWorkbook } = require('./exports')

test('导出保留公式样式文本和前导零，日期与数值保留类型', async () => {
  const texts = ['=1+1', '+SUM(A1:A2)', '-1+1', '@SUM(A1:A2)', '\t=1+1', '\r=1+1', '00001', '普通姓名']
  const date = new Date('2026-11-15T00:00:00Z')
  let buffer
  await sendWorkbook({ writeHead() {}, end(value) { buffer = value } }, '测试.xlsx', [{
    name: '文本测试',
    columns: [
      { header: '文本', key: 'text', width: 30 },
      { header: '学时', key: 'minutes', width: 12 },
      { header: '日期', key: 'date', width: 24, style: { numFmt: 'yyyy-mm-dd' } },
    ],
    rows: texts.map(text => ({ text, minutes: 60, date })),
  }])
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  texts.forEach((text, i) => {
    const cell = sheet.getCell(i + 2, 1)
    assert.equal(cell.type, ExcelJS.ValueType.String)
    // XML 解析会把回车规范化为换行，但单元格仍必须是文本。
    assert.equal(cell.value, text.replace(/\r/g, '\n'))
    assert.equal(cell.numFmt, '@')
    assert.equal(sheet.getCell(i + 2, 2).value, 60)
    assert.equal(sheet.getCell(i + 2, 3).type, ExcelJS.ValueType.Date)
  })
})
