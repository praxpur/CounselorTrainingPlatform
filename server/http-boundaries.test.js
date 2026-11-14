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

test('非法 URL 和非法路径编码返回 400', async () => {
  for (const path of ['http://[', '/api/%ZZ', '/api/%FF']) {
    await new Promise((resolve, reject) => {
      const request = http.get(base, { path }, response => {
        assert.equal(response.statusCode, 400, path)
        response.resume()
        response.on('end', resolve)
      })
      request.on('error', reject)
    })
  }
})

test('用户表新增敏感字段后 /api/me 仍只返回公开字段', async () => {
  db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT 'secret'")
  db.exec("ALTER TABLE users ADD COLUMN openid TEXT DEFAULT 'private-id'")
  const login = await fetch(base + '/api/auth/dev', {
    method: 'POST',
    body: JSON.stringify({ id: 'safe-user', name: '姓名', department: '学院' }),
  })
  const { token } = await login.json()
  const response = await fetch(base + '/api/me', { headers: { authorization: 'Bearer ' + token } })
  assert.equal(response.status, 200)
  const user = await response.json()
  assert.deepEqual(Object.keys(user).sort(), ['department', 'enabled', 'id', 'name', 'role'])
})
