const http = require('node:http')
const crypto = require('node:crypto')
const probe = process.argv.includes('--probe')
const {server, db} = probe ? {server: http.createServer((req,res) => res.end('ok'))} : require('./server')
if (!probe) {
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
  "INSERT INTO activities(id,title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES(1,'并发测试','','',?,?,125,60,?)",
).run(now + 3600000, now + 7200000, now)
if (process.env.LOAD_UNLIMITED === '1') db.exec('UPDATE activities SET capacity=0')
process.send({tokens})
}

let accepted=0, requests=0
server.on('connection', () => accepted++)
server.on('request', () => requests++)
server.listen({port:0,host:'127.0.0.1',backlog:Number(process.env.LISTEN_BACKLOG || 2048)}, () => process.send({port:server.address().port, journal:db && db.prepare('PRAGMA journal_mode').get(), synchronous:db && db.prepare('PRAGMA synchronous').get()}))
process.on('message', () => {
 const result = {accepted, requests}
 if(db) {
  result.count=db.prepare('SELECT COUNT(*) count FROM registrations').get().count
  result.duplicates=db.prepare('SELECT activity_id,user_id FROM registrations GROUP BY activity_id,user_id HAVING COUNT(*)>1').all().length
  result.integrity=db.prepare('PRAGMA integrity_check').all()
  result.foreignKeys=db.prepare('PRAGMA foreign_key_check').all()
 }
 server.close(() => { if(db) db.close(); process.send({result}, () => process.disconnect()) })
 server.closeAllConnections()
})
