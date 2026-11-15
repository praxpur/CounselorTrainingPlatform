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
      { header: '学时', key: 'hours', width: 12 },
      { header: '日期', key: 'date', width: 24, style: { numFmt: 'yyyy-mm-dd' } },
    ],
    rows: texts.map(text => ({ text, hours: 60, date })),
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

test('导出有行数和内容大小边界，拒绝后不会占用任务槽', async () => {
  const { assertExportAvailable } = require('./exports')
  const res = { writeHead() {},end() {} }
  const columns = [{ header:'文本',key:'value',width:20 }]
  await assert.rejects(sendWorkbook(res,'large.xlsx',[{ name:'数据',columns,rows:Array.from({length:10001},()=>({value:'x'})) }]),{status:413})
  assert.doesNotThrow(assertExportAvailable)
  await assert.rejects(sendWorkbook(res,'large.xlsx',[{ name:'数据',columns,rows:Array.from({length:10000},()=>({value:'x'.repeat(2000)})) }]),{status:413})
  assert.doesNotThrow(assertExportAvailable)
})

test('独立导出线程保持事件循环可运行，并发任务明确返回繁忙', async () => {
  const { assertExportAvailable }=require('./exports')
  let finished=false,buffer
  const work=sendWorkbook({writeHead(){},end(value){buffer=value}},'后台导出.xlsx',[{
    name:'数据',columns:[{header:'工号',key:'id',width:18},{header:'学时',key:'hours',width:12}],
    rows:Array.from({length:5000},(_,index)=>({id:String(index).padStart(6,'0'),hours:1.5})),
  }]).finally(()=>{finished=true})
  assert.throws(assertExportAvailable,{status:429})
  await assert.rejects(sendWorkbook({writeHead(){},end(){}},'重复.xlsx',[]),{status:429})
  await new Promise(setImmediate)
  assert.equal(finished,false)
  await work
  assert.ok(buffer.length>1000)
  assert.doesNotThrow(assertExportAvailable)
})

test('下载中断会终止导出线程并释放任务槽', async () => {
  const { EventEmitter }=require('node:events')
  const { assertExportAvailable }=require('./exports')
  const res=new EventEmitter()
  res.writeHead=()=>{};res.end=()=>{}
  const work=sendWorkbook(res,'中断.xlsx',[{
    name:'数据',columns:[{header:'文本',key:'text',width:20}],rows:Array.from({length:1000},()=>({text:'测试'})),
  }])
  res.destroyed=true;res.emit('close')
  await assert.rejects(work,{status:499})
  assert.doesNotThrow(assertExportAvailable)
})
