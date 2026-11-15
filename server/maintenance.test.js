const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { backupBundle, verifyBundle, restoreBundle, cleanup, withMaintenanceLock, configuredPaths } = require('./maintenance')
const id = () => crypto.randomBytes(24).toString('hex')
async function fixture({ legacy = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'training-maintenance-'))
  const dbPath = path.join(root, 'live.db'), uploadDir = path.join(root, 'uploads'), backupDir = path.join(root, 'backups')
  await fs.mkdir(uploadDir)
  const db = new DatabaseSync(dbPath)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,expires INTEGER);
    CREATE TABLE proof_files(id TEXT PRIMARY KEY,bytes INTEGER,created_at INTEGER,external_id INTEGER,experience_id INTEGER${legacy ? '' : ',ever_submitted INTEGER NOT NULL DEFAULT 0'});
    CREATE TABLE audit_logs(action TEXT,target TEXT);
    CREATE TRIGGER audit_proof_delete AFTER DELETE ON proof_files BEGIN INSERT INTO audit_logs VALUES('proof.deleted',OLD.id); END;
    CREATE TRIGGER audit_session_delete AFTER DELETE ON sessions BEGIN INSERT INTO audit_logs VALUES('session.deleted',OLD.token_hash); END;`)
  return { root, dbPath, uploadDir, backupDir, db, legacy }
}
async function addProof(state, { age = 0, linked = false, everSubmitted = linked, content = 'proof' } = {}) {
  const key = id(), bytes = Buffer.from(content)
  await fs.writeFile(path.join(state.uploadDir, key), bytes)
  const values = [key, bytes.length, Date.now() - age, linked ? 1 : null, null, ...(state.legacy ? [] : [everSubmitted ? 1 : 0])]
  state.db.prepare('INSERT INTO proof_files VALUES(' + values.map(() => '?').join(',') + ')').run(...values)
  return key
}
async function dispose(state) {
  state.db.close()
  await fs.rm(state.root, { recursive: true, force: true })
}

test('WAL 在线备份包含一致的数据库与材料，校验后可恢复到全新目录', async () => {
  const state = await fixture()
  try {
    const first = await addProof(state, { linked: true, content: 'first proof' })
    // 保持源库在线且 WAL 未 checkpoint，备份必须读取已提交 WAL。
    assert.ok((await fs.stat(state.dbPath + '-wal')).size > 0)
    state.db.exec('CREATE TABLE payload(value TEXT); BEGIN IMMEDIATE')
    const insert = state.db.prepare('INSERT INTO payload VALUES(?)')
    for (let index = 0; index < 512; index++) insert.run('x'.repeat(4096))
    state.db.exec('COMMIT')
    const second = id(), secondContent = Buffer.from('committed during backup')
    await fs.writeFile(path.join(state.uploadDir, second), secondContent)
    let changed = false
    const result = await backupBundle({ ...state, onProgress: progress => {
      if (!changed && progress.remainingPages > 0) {
        changed = true
        state.db.prepare('INSERT INTO proof_files(id,bytes,created_at,external_id,experience_id) VALUES(?,?,?,?,?)').run(second, secondContent.length, Date.now(), null, null)
      }
    } })
    assert.equal(changed, true)
    const verified = await verifyBundle(result.directory)
    assert.equal(verified.files, 2)
    const dbPath = path.join(state.root, 'restore', 'restored.db'), uploadDir = path.join(state.root, 'restore', 'uploads')
    const restored = await restoreBundle({ bundle: result.directory, dbPath, uploadDir })
    assert.equal(restored.files, 2)
    const copy = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(copy.prepare('SELECT COUNT(*) n FROM payload').get().n, 512)
      assert.equal(copy.prepare('SELECT COUNT(*) n FROM proof_files').get().n, 2)
      assert.equal(Object.values(copy.prepare('PRAGMA integrity_check').get())[0], 'ok')
    } finally { copy.close() }
    assert.equal(await fs.readFile(path.join(uploadDir, first), 'utf8'), 'first proof')
    assert.equal(await fs.readFile(path.join(uploadDir, second), 'utf8'), 'committed during backup')
    await assert.rejects(restoreBundle({ bundle: result.directory, dbPath, uploadDir }), /禁止覆盖/)
  } finally { await dispose(state) }
})

test('损坏材料和越界清单会拒绝恢复，现有目标文件不被覆盖', async () => {
  const state = await fixture()
  try {
    const key = await addProof(state)
    const result = await backupBundle(state)
    await fs.writeFile(path.join(result.directory, 'uploads', key), 'tampered')
    await assert.rejects(verifyBundle(result.directory), /材料校验失败/)
    const destination = path.join(state.root, 'new.db'), uploads = path.join(state.root, 'new-uploads')
    await assert.rejects(restoreBundle({ bundle: result.directory, dbPath: destination, uploadDir: uploads }), /材料校验失败/)
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' })
    const manifestPath = path.join(result.directory, 'manifest.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.files[0].id = '../../outside'
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyBundle(result.directory), /清单/)
    await fs.writeFile(destination, 'existing data')
    await assert.rejects(restoreBundle({ bundle: result.directory, dbPath: destination, uploadDir: uploads }), /禁止覆盖/)
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing data')
    await fs.writeFile(manifestPath, '{"secret":"must-not-echo", broken')
    await assert.rejects(verifyBundle(result.directory), error => error.message === '备份清单 JSON 格式错误' && !error.message.includes('must-not-echo'))
  } finally { await dispose(state) }
})

test('备份与清理使用同一排他维护锁，锁不会按时间被自动抢走', async () => {
  const state = await fixture()
  try {
    await withMaintenanceLock(state.dbPath, async () => {
      await assert.rejects(backupBundle(state), { code: 'MAINTENANCE_BUSY' })
    })
    assert.equal((await backupBundle(state)).files, 0)
    await assert.rejects(fs.stat(state.dbPath + '.maintenance-lock'), { code: 'ENOENT' })
    assert.throws(() => configuredPaths({}), /DB_PATH/)
  } finally { await dispose(state) }
})

test('清理仅移除过期会话与超过七天的未绑定材料，并保留审计和已提交证明', async () => {
  const state = await fixture()
  try {
    const old = await addProof(state, { age: 8 * 86400000 })
    const recent = await addProof(state, { age: 86400000 })
    const linked = await addProof(state, { age: 100 * 86400000, linked: true })
    const untracked = id(), unknown = path.join(state.uploadDir, 'operator-note.txt')
    await fs.writeFile(path.join(state.uploadDir, untracked), 'incomplete upload')
    await fs.utimes(path.join(state.uploadDir, untracked), new Date(0), new Date(0))
    await fs.writeFile(unknown, 'keep this operator file')
    state.db.prepare('INSERT INTO sessions VALUES(?,?)').run('expired', Date.now() - 1000)
    state.db.prepare('INSERT INTO sessions VALUES(?,?)').run('current', Date.now() + 86400000)
    const result = await withMaintenanceLock(state.dbPath, () => cleanup(state))
    assert.equal(result.sessionsDeleted, 1)
    assert.equal(result.orphanRowsDeleted, 1)
    assert.equal(result.filesDeleted, 2)
    assert.equal(result.untrackedFilesDeleted, 1)
    assert.equal(result.trashRemaining, 0)
    await assert.rejects(fs.stat(path.join(state.uploadDir, old)), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(state.uploadDir, recent), 'utf8'), 'proof')
    assert.equal(await fs.readFile(path.join(state.uploadDir, linked), 'utf8'), 'proof')
    assert.equal(await fs.readFile(unknown, 'utf8'), 'keep this operator file')
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 2)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1)
    await assert.rejects(cleanup({ ...state, orphanDays: 1 }), /至少保留 7 天/)
  } finally { await dispose(state) }
})

test('清理数据库删除失败时恢复材料，上次中断的隔离文件可恢复', async () => {
  const state = await fixture()
  try {
    const key = await addProof(state, { age: 8 * 86400000 })
    state.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON proof_files BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
    await assert.rejects(cleanup(state), /audit unavailable/)
    assert.equal(await fs.readFile(path.join(state.uploadDir, key), 'utf8'), 'proof')
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM proof_files').get().n, 1)
    state.db.exec('DROP TRIGGER fail_delete')
    const trash = path.join(state.uploadDir, '.maintenance-trash')
    await fs.rename(path.join(state.uploadDir, key), path.join(trash, key))
    // 模拟崩溃后事务回滚，但文件已经移入隔离区；备份先拒绝不一致状态。
    await assert.rejects(backupBundle(state), /未完成的材料清理/)
    const result = await cleanup(state)
    assert.equal(result.filesRecovered, 1)
    assert.equal(result.orphanRowsDeleted, 1)
    assert.equal(state.db.prepare('SELECT COUNT(*) n FROM proof_files').get().n, 0)
    assert.equal((await fs.readdir(trash)).length, 0)
  } finally { await dispose(state) }
})

test('曾经提交后解绑的证明仍保留，不会当作过期孤儿删除', async () => {
  const state = await fixture()
  try {
    const submitted = await addProof(state, { age: 100 * 86400000, linked: true })
    state.db.prepare('UPDATE proof_files SET external_id=NULL WHERE id=?').run(submitted)
    const unused = await addProof(state, { age: 8 * 86400000 })
    const result = await withMaintenanceLock(state.dbPath, () => cleanup(state))
    assert.equal(result.metadataCleanupSkipped, false)
    assert.equal(result.orphanRowsDeleted, 1)
    assert.ok(state.db.prepare('SELECT id FROM proof_files WHERE id=?').get(submitted))
    assert.equal(await fs.readFile(path.join(state.uploadDir, submitted), 'utf8'), 'proof')
    assert.equal(state.db.prepare('SELECT id FROM proof_files WHERE id=?').get(unused), undefined)
  } finally { await dispose(state) }
})

test('旧 schema 无提交历史标志时保守保留元数据材料，仅清理无元数据旧文件', async () => {
  const state = await fixture({ legacy: true })
  try {
    const protectedFile = await addProof(state, { age: 100 * 86400000 })
    const untracked = id()
    await fs.writeFile(path.join(state.uploadDir, untracked), 'old incomplete upload')
    await fs.utimes(path.join(state.uploadDir, untracked), new Date(0), new Date(0))
    const result = await withMaintenanceLock(state.dbPath, () => cleanup(state))
    assert.equal(result.metadataCleanupSkipped, true)
    assert.equal(result.orphanRowsDeleted, 0)
    assert.equal(result.untrackedFilesDeleted, 1)
    assert.ok(state.db.prepare('SELECT id FROM proof_files WHERE id=?').get(protectedFile))
    assert.equal(await fs.readFile(path.join(state.uploadDir, protectedFile), 'utf8'), 'proof')
    await assert.rejects(fs.stat(path.join(state.uploadDir, untracked)), { code: 'ENOENT' })
  } finally { await dispose(state) }
})

test('维护 CLI 可对应用审计库备份、清理并恢复，备份前不会执行迁移', async () => {
  const { promisify } = require('node:util')
  const execFile = promisify(require('node:child_process').execFile)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'training-maintenance-cli-'))
  const dbPath = path.join(root, 'live.db'), uploadDir = path.join(root, 'uploads'), backupDir = path.join(root, 'backups')
  const environment = { ...process.env, NODE_ENV: 'production', DB_PATH: dbPath, UPLOAD_DIR: uploadDir, BACKUP_DIR: backupDir }
  const options = { cwd: __dirname, env: environment, timeout: 30000 }
  try {
    await execFile(process.execPath, ['-e', `
      const fs=require('node:fs'),path=require('node:path');const {db}=require('./server');
      const id='a'.repeat(48),content=Buffer.from('cli-proof');
      fs.mkdirSync(process.env.UPLOAD_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.UPLOAD_DIR,id),content);
      db.prepare("INSERT INTO users(id,name,department,role) VALUES('maintenance-user','维护测试','学院','counselor')").run();
      db.prepare('INSERT INTO proof_files(id,user_id,name,mime_type,bytes,created_at) VALUES(?,?,?,?,?,?)').run(id,'maintenance-user','证明.pdf','application/pdf',content.length,Date.now()-8*86400000);
      db.close();`], options)
    // 备份必须保留原始 schema，不通过应用启动悄悄修补这个只读探针。
    const source = new DatabaseSync(dbPath)
    source.exec("CREATE TABLE readonly_probe(value TEXT); INSERT INTO readonly_probe VALUES('unchanged'); ALTER TABLE activities ADD COLUMN credit_minutes REAL")
    source.close()
    const backedUp = await execFile(process.execPath, ['maintenance.js', 'backup'], options)
    const bundle = JSON.parse(backedUp.stdout.trim()).directory
    assert.equal((await verifyBundle(bundle)).files, 1)
    const snapshot = new DatabaseSync(path.join(bundle, 'training.db'), { readOnly: true })
    try {
      // 如果 backup 提前 require server，单位迁移会因新旧字段冲突而失败。
      assert.ok(snapshot.prepare('PRAGMA table_info(activities)').all().some(column => column.name === 'credit_minutes'))
      assert.ok(snapshot.prepare('PRAGMA table_info(activities)').all().some(column => column.name === 'credit_hours'))
    } finally { snapshot.close() }
    const liveSchema = new DatabaseSync(dbPath)
    liveSchema.exec('ALTER TABLE activities DROP COLUMN credit_minutes')
    liveSchema.close()
    const cleaned = await execFile(process.execPath, ['maintenance.js', 'cleanup'], options)
    assert.equal(JSON.parse(cleaned.stdout.trim()).orphanRowsDeleted, 1)
    const destination = path.join(root, 'restore', 'training.db'), uploads = path.join(root, 'restore', 'uploads')
    await execFile(process.execPath, ['maintenance.js', 'restore', bundle, destination, uploads], options)
    const restored = new DatabaseSync(destination, { readOnly: true })
    try {
      assert.equal(restored.prepare('SELECT value FROM readonly_probe').get().value, 'unchanged')
      assert.equal(restored.prepare('SELECT COUNT(*) n FROM proof_files').get().n, 1)
    } finally { restored.close() }
    assert.equal(await fs.readFile(path.join(uploads, 'a'.repeat(48)), 'utf8'), 'cli-proof')
    const live = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(live.prepare('SELECT COUNT(*) n FROM proof_files').get().n, 0)
      assert.ok(live.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='proof_files.delete'").get().n >= 1)
    } finally { live.close() }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
