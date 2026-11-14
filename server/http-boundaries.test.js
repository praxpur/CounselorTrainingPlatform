process.env.DB_PATH = ':memory:'
process.env.ENABLE_DEV_LOGIN = '1'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { server, db } = require('./server')
let base
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  db.close()
})

test('未发送完的超限请求立即收到 413 并关闭连接，不创建用户', async () => {
  for (const headers of [{ 'content-length': '20000' }, {}]) {
    await new Promise((resolve, reject) => {
      const request = http.request(base + '/api/auth/dev', { method: 'POST', headers }, response => {
        assert.equal(response.statusCode, 413)
        assert.equal(response.headers.connection, 'close')
        response.resume()
        response.on('end', resolve)
        response.on('error', reject)
      })
      request.on('error', reject)
      request.setTimeout(2000, () => request.destroy(new Error('超限响应仍在等待请求结束')))
      request.write('x'.repeat(17000))
      // 故意不调用 end()；超过大小限制后不能等待 end 事件。
    })
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0)
  assert.equal((await fetch(base + '/health')).status, 200)
})
