// 独立内存数据库，绝不连接或修改开发/正式数据库。
process.env.DB_PATH = ':memory:'
const http = require('node:http')
const crypto = require('node:crypto')
const net = require('node:net')
const { performance } = require('node:perf_hooks')
const { server, db } = require('./server')
const tokens = []
const now = Date.now()
for (let i = 0; i < 500; i++) {
  const id = 'load-' + i
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare("INSERT INTO users(id,name,department,role) VALUES(?,?,?,'counselor')").run(
    id,
    id,
    '负载测试',
  )
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
    crypto.createHash('sha256').update(token).digest('hex'),
    id,
    now + 3600000,
  )
  tokens.push(token)
}
db.prepare(
  "INSERT INTO activities(id,title,description,location,starts_at,ends_at,capacity,credit_minutes,created_at) VALUES(1,'并发测试','','',?,?,125,60,?)",
).run(now + 3600000, now + 7200000, now)
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxTotalSockets: 500,
  maxFreeSockets: 500,
})
const socketPool = []
const coldStart = process.argv.includes('--cold')

async function phase(name, path, method = 'GET') {
  const responses = await Promise.all(
    tokens.map(
      (token) =>
        new Promise((resolve) => {
          const started = performance.now()
          const request = http.request(
            {
              host: '127.0.0.1',
              port: server.address().port,
              path,
              method,
              agent,
              headers: { authorization: 'Bearer ' + token },
            },
            (response) => {
              response.resume()
              response.on('end', () =>
                resolve({ status: response.statusCode, ms: performance.now() - started }),
              )
            },
          )
          request.setTimeout(15000, () => request.destroy(new Error('request timeout')))
          request.on('error', (error) =>
            resolve({ status: error.code || error.message, ms: performance.now() - started }),
          )
          request.end()
        }),
    ),
  )
  const statuses = {}
  for (const response of responses) statuses[response.status] = (statuses[response.status] || 0) + 1
  const timings = responses.map((r) => r.ms).sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      phase: name,
      concurrentUsers: 500,
      statuses,
      p95Ms: Math.round(timings[474]),
      maxMs: Math.round(timings[499]),
    }),
  )
  return statuses
}

;(async () => {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ port: 0, host: '127.0.0.1', backlog: 2048 }, resolve)
    })
    if (!coldStart) {
      // 分批建立连接，再同时发送 500 个请求；与 500 个新 TCP 连接同时涌入分开衡量。
      for (let index = 0; index < 500; index += 25) {
        await Promise.all(
          Array.from(
            { length: 25 },
            () =>
              new Promise((resolve, reject) => {
                const socket = net.createConnection({
                  host: '127.0.0.1',
                  port: server.address().port,
                })
                socket.once('error', reject)
                socket.once('connect', () => {
                  socket.removeListener('error', reject)
                  socketPool.push(socket)
                  resolve()
                })
              }),
          ),
        )
      }
      agent.createConnection = (options) => socketPool.shift() || net.createConnection(options)
    }
    console.log(
      JSON.stringify({ connectionMode: coldStart ? 'cold-burst' : '500-preconnected-clients' }),
    )
    const reads = await phase('activity-list', '/api/activities')
    const registrations = await phase(
      'capacity-limited-registration',
      '/api/activities/1/register',
      'POST',
    )
    const duplicates = await phase('duplicate-registration', '/api/activities/1/register', 'POST')
    const reports = await phase('personal-annual', '/api/my/annual')
    const count = db.prepare('SELECT COUNT(*) count FROM registrations').get().count
    if (
      reads[200] !== 500 ||
      registrations[200] !== 125 ||
      registrations[409] !== 375 ||
      duplicates[409] !== 500 ||
      reports[200] !== 500 ||
      count !== 125
    )
      throw new Error('并发测试未达到预期，检查各阶段结果')
    console.log(
      JSON.stringify({
        passed: true,
        registrations: count,
        note: '本机内存数据库结果，不代表学校正式服务器性能',
      }),
    )
  } finally {
    agent.destroy()
    for (const socket of socketPool) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
})().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
