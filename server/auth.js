const crypto = require('node:crypto')
const { promisify } = require('node:util')
const scrypt = promisify(crypto.scrypt)
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex')
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
let hashing = 0

async function derive(password, salt) {
  if (hashing >= 4) fail(429, '登录请求繁忙，请稍后重试')
  hashing++
  try {
    return await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })
  } finally {
    hashing--
  }
}
function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128
}
async function encodePassword(password) {
  if (!validPassword(password)) fail(400, '密码须为 12—128 个字符')
  const salt = crypto.randomBytes(16).toString('hex')
  const key = await derive(password, salt)
  return 'scrypt$' + salt + '$' + key.toString('hex')
}
async function verifyPassword(password, encoded) {
  const [, salt, key] = (encoded || ('scrypt$' + '0'.repeat(32) + '$' + '0'.repeat(128))).split('$')
  const derived = await derive(password, salt)
  return crypto.timingSafeEqual(derived, Buffer.from(key, 'hex'))
}

function createAuthentication(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS credentials(
    user_id TEXT PRIMARY KEY REFERENCES users(id), password_hash TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_limit_expiry ON auth_limits(reset_at);
    CREATE TABLE IF NOT EXISTS verified_sessions(
      token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE);`)
  function limit(kind, value, max) {
    const key = hashToken(kind + ':' + value), now = Date.now()
    db.prepare('DELETE FROM auth_limits WHERE reset_at<=?').run(now)
    const entry = db.prepare('SELECT hits FROM auth_limits WHERE key=?').get(key)
    if (entry && entry.hits >= max) fail(429, '尝试次数过多，请 15 分钟后重试')
    db.prepare(`INSERT INTO auth_limits VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET hits=hits+1`).run(key, now + 15 * 60000)
  }
  function credential(id) {
    return db.prepare(`SELECT c.password_hash,c.must_change,u.enabled FROM credentials c
      JOIN users u ON u.id=c.user_id WHERE c.user_id=?`).get(id)
  }
  function issue(id) {
    const token = crypto.randomBytes(32).toString('hex'), now = Date.now()
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now)
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token), id, now + 8 * 3600000)
    db.prepare('INSERT INTO verified_sessions(token_hash) VALUES(?)').run(hashToken(token))
    const user = db.prepare('SELECT id,name,department,role FROM users WHERE id=?').get(id)
    return { token, user, mustChangePassword: Boolean(credential(id).must_change) }
  }
  return {
    mustChange: id => Boolean(credential(id)?.must_change),
    async login(input, ip) {
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      limit('ip', ip, 3000)
      limit('account', id, 10)
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || !validPassword(input.password))
        fail(401, '工号或密码错误，或账号已停用')
      const stored = credential(id)
      const valid = await verifyPassword(input.password, stored?.password_hash)
      if (!valid || !stored?.enabled) fail(401, '工号或密码错误，或账号已停用')
      db.exec('BEGIN IMMEDIATE')
      try {
        // 等待写锁时另一进程也可能停用账号或重置密码，必须在锁内复核。
        const current = credential(id)
        if (!current?.enabled || current.password_hash !== stored.password_hash)
          fail(401, '工号或密码错误，或账号已停用')
        const result = issue(id)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async changePassword(user, input, ip, revalidate) {
      limit('password-ip', ip, 3000)
      limit('password-account', user.id, 10)
      const stored = credential(user.id)
      if (!stored || !validPassword(input.oldPassword) || !await verifyPassword(input.oldPassword, stored.password_hash))
        fail(403, '原密码错误')
      if (input.oldPassword === input.newPassword) fail(400, '新密码不能与原密码相同')
      const encoded = await encodePassword(input.newPassword)
      db.exec('BEGIN IMMEDIATE')
      try {
        revalidate()
        const current = credential(user.id)
        if (!current?.enabled || current.password_hash !== stored.password_hash)
          fail(401, '账号状态已改变，请重新登录')
        db.prepare('UPDATE credentials SET password_hash=?,must_change=0 WHERE user_id=?').run(encoded, user.id)
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
        const result = issue(user.id)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}
module.exports = { createAuthentication, encodePassword }
