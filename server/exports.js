const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const MAX_ROWS = 10000, MAX_BYTES = 16 * 1024 * 1024, MAX_OUTPUT = 32 * 1024 * 1024
let active = false
function error(status, message) { return Object.assign(new Error(message), { status }) }
function assertExportAvailable() {
  if (active) throw error(429,'当前已有导出任务，请稍后重试')
}
function selectSheets(sheets) {
  let count = 0, bytes = 0
  return sheets.map(sheet => ({ ...sheet, rows: sheet.rows.map(row => {
    if (++count > MAX_ROWS) throw error(413,'导出最多 10000 行，请按年份或人员分批导出')
    const selected = {}
    for (const column of sheet.columns) {
      const value = row[column.key] ?? null
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) throw error(500,'导出字段格式错误')
      bytes += typeof value === 'string' ? Buffer.byteLength(value,'utf8') : 24
      if (bytes > MAX_BYTES) throw error(413,'导出内容过大，请缩小年份或人员范围')
      selected[column.key] = value
    }
    return selected
  }) }))
}

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name)
  sheet.columns = columns
  sheet.addRows(rows)
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
  sheet.getRow(1).height = 28
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25489C' } }
  })
  sheet.eachRow((row, index) => {
    if (index === 1) return
    let lines = 1
    row.eachCell((cell) => {
      cell.font = { size: 11 }
      cell.alignment = { vertical: 'top', wrapText: true }
      if (typeof cell.value === 'string') {
        // XLSX 字符串单元格不会作为公式执行；显式文本格式也保留前导零。
        cell.numFmt = '@'
        const width = sheet.getColumn(cell.col).width || 20
        const textWidth = [...cell.value].reduce(
          (sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1),
          0,
        )
        lines = Math.max(
          lines,
          Math.ceil(textWidth / Math.max(1, width - 2)),
          cell.value.split('\n').length,
        )
      }
    })
    row.height = Math.min(400, Math.max(24, lines * 16))
  })
  return sheet
}


async function render(sheets) {
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '济南大学学生工作处'
  for (const sheet of sheets) addSheet(workbook,sheet.name,sheet.columns,sheet.rows)
  const buffer = await workbook.xlsx.writeBuffer()
  if (buffer.length > MAX_OUTPUT) throw error(413,'导出文件过大，请分批导出')
  return new Uint8Array(buffer)
}
async function sendWorkbook(res,filename,sheets) {
  assertExportAvailable()
  active = true
  let worker, timer, onClose
  try {
    const selected = selectSheets(sheets)
    const buffer = await new Promise((resolve,reject) => {
      worker = new Worker(__filename,{ workerData: { sheets: selected }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
      timer = setTimeout(() => reject(error(503,'导出耗时过长，请缩小范围后重试')),30000)
      worker.once('message',message => {
        if (message.failure) reject(error(message.status || 500,message.failure))
        else resolve(Buffer.from(message.buffer,message.byteOffset,message.byteLength))
      })
      worker.once('error',() => reject(error(503,'导出资源不足，请缩小范围后重试')))
      worker.once('exit',code => { if (code !== 0) reject(error(503,'导出进程已退出，请重试')) })
      onClose = () => reject(error(499,'下载已取消'))
      res.once?.('close',onClose)
    })
    clearTimeout(timer)
    res.off?.('close',onClose)
    await worker.terminate()
    worker = null
    if (res.destroyed) return
    res.writeHead(200,{
      'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(filename),
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':buffer.length,
    })
    if (typeof res.once === 'function') await new Promise(resolve => {
      res.once('finish',resolve);res.once('close',resolve);res.end(buffer)
    })
    else res.end(buffer)
  } finally {
    clearTimeout(timer)
    if (onClose) res.off?.('close',onClose)
    if (worker) await worker.terminate()
    active = false
  }
}
if (!isMainThread) render(workerData.sheets).then(bytes => {
  parentPort.postMessage(bytes,[bytes.buffer]);parentPort.close()
},failure => {
  parentPort.postMessage({ failure: failure.status ? failure.message : '导出生成失败',status: failure.status || 500 });parentPort.close()
})
module.exports = { sendWorkbook, assertExportAvailable }
