// 数据库与私有材料的备份、校验、恢复和清理；维护操作共用排他锁。
const fs = require('node:fs/promises')
const { createReadStream, constants } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { DatabaseSync, backup } = require('node:sqlite')

const PROOF_ID = /^[a-f0-9]{48}$/
const DAY = 86400000
function fail(message, code = 'MAINTENANCE_ERROR') {
  throw Object.assign(new Error(message), { code })
}
function absolute(value, name) {
  if (!value || !path.isAbsolute(value) || value === ':memory:') fail(name + ' 必须是显式绝对路径')
  return path.resolve(value)
}
async function exists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function regularFile(file) {
  const state = await fs.lstat(file)
  if (!state.isFile() || state.isSymbolicLink())
    fail('材料或数据库不是普通文件：' + path.basename(file))
  return state
}
async function digest(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function proofPath(root, id) {
  if (!PROOF_ID.test(id)) fail('材料编号不合法')
  return path.join(root, id)
}
async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const state = await fs.lstat(directory)
  if (!state.isDirectory() || state.isSymbolicLink()) fail('维护目录不能是文件或符号链接')
}
async function removeOwnedStaging(root, target) {
  if (path.dirname(target) !== root || !path.basename(target).startsWith('.partial-'))
    fail('拒绝清理非本任务临时目录')
  await fs.rm(target, { recursive: true, force: true })
}
async function withMaintenanceLock(dbPath, work) {
  dbPath = absolute(dbPath, 'DB_PATH')
  const lock = dbPath + '.maintenance-lock'
  try {
    await fs.mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST')
      fail('维护锁已存在；确认原维护进程结束后再按文档处理，不会自动抢锁', 'MAINTENANCE_BUSY')
    throw error
  }
  try {
    await fs.writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    )
    return await work()
  } finally {
    await fs.unlink(path.join(lock, 'owner.json')).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    await fs.rmdir(lock)
  }
}
function proofRows(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proof_files'").get())
    return []
  return db.prepare('SELECT id,bytes FROM proof_files ORDER BY id').all()
}
function integrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all()
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail('数据库完整性检查失败')
  if (db.prepare('PRAGMA foreign_key_check').get()) fail('数据库外键检查失败')
}
async function rejectBundleJournals(databasePath) {
  for (const suffix of ['-wal', '-journal']) {
    const filename = databasePath + suffix
    if (await exists(filename)) {
      const state = await regularFile(filename)
      if (state.size > 0) fail('备份包包含额外 WAL 或 journal，请重新生成完整备份')
    }
  }
}
async function verifyBundle(bundle) {
  return withVerifiedBundle(bundle, (verified) => ({
    manifest: verified.manifest,
    databasePath: path.join(bundle, 'training.db'),
    files: verified.files,
  }))
}
async function withVerifiedBundle(bundle, work) {
  bundle = absolute(bundle, '备份目录')
  const manifestPath = path.join(bundle, 'manifest.json')
  const state = await regularFile(manifestPath)
  if (state.size > 64 * 1024 * 1024) fail('备份清单过大')
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) fail('备份清单 JSON 格式错误')
    throw error
  }
  if (manifest.version !== 1 || !manifest.database || !Array.isArray(manifest.files))
    fail('备份清单格式无效')
  const databasePath = path.join(bundle, 'training.db')
  const databaseState = await regularFile(databasePath)
  if (
    manifest.database.bytes !== databaseState.size ||
    !/^[a-f0-9]{64}$/.test(manifest.database.sha256)
  )
    fail('备份数据库校验值不匹配')
  await rejectBundleJournals(databasePath)
  // 只打开私有目录中的副本，绝不让 SQLite 读取备份目录中未列入清单的边车文件。
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'training-verified-'))
  const sealedPath = path.join(temporary, 'training.db')
  try {
    await fs.copyFile(databasePath, sealedPath, constants.COPYFILE_EXCL)
    await fs.chmod(sealedPath, 0o600)
    if (
      (await fs.stat(sealedPath)).size !== manifest.database.bytes ||
      (await digest(sealedPath)) !== manifest.database.sha256
    )
      fail('备份数据库校验值不匹配')
    const snapshot = new DatabaseSync(sealedPath, { readOnly: true })
    let rows
    try {
      integrity(snapshot)
      rows = proofRows(snapshot)
    } finally {
      snapshot.close()
    }
    const expected = new Map(rows.map((row) => [row.id, row.bytes]))
    const seen = new Set()
    if (expected.size !== manifest.files.length) fail('材料清单与数据库不一致')
    for (const file of manifest.files) {
      if (
        !PROOF_ID.test(file.id) ||
        seen.has(file.id) ||
        !expected.has(file.id) ||
        expected.get(file.id) !== file.bytes ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        fail('材料清单无效或存在重复')
      seen.add(file.id)
      const filename = proofPath(path.join(bundle, 'uploads'), file.id)
      const fileState = await regularFile(filename)
      if (fileState.size !== file.bytes || (await digest(filename)) !== file.sha256)
        fail('备份材料校验失败：' + file.id)
    }
    await rejectBundleJournals(databasePath)
    if (
      (await digest(databasePath)) !== manifest.database.sha256 ||
      (await digest(sealedPath)) !== manifest.database.sha256
    )
      fail('备份数据库校验值不匹配')
    return await work({ manifest, databasePath: sealedPath, files: rows.length })
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}
async function backupBundle({ dbPath, uploadDir, backupDir, onProgress }) {
  if (typeof backup !== 'function') fail('在线备份需要 Node.js 22.16.0 或更高版本')
  dbPath = absolute(dbPath, 'DB_PATH')
  uploadDir = absolute(uploadDir, 'UPLOAD_DIR')
  backupDir = absolute(backupDir, 'BACKUP_DIR')
  await regularFile(dbPath)
  await ensureDirectory(backupDir)
  return withMaintenanceLock(dbPath, async () => {
    const trash = path.join(uploadDir, '.maintenance-trash')
    if ((await exists(trash)) && (await fs.readdir(trash)).length)
      fail('存在未完成的材料清理，请先运行 cleanup 恢复，再备份')
    const name =
      new Date().toISOString().replace(/[-:.]/g, '') + '-' + crypto.randomBytes(4).toString('hex')
    const staging = path.join(backupDir, '.partial-' + name),
      destination = path.join(backupDir, name)
    await ensureDirectory(staging)
    try {
      const databasePath = path.join(staging, 'training.db')
      // 只读源连接，不加载 server.js，备份前不进行业务迁移或写入。
      const source = new DatabaseSync(dbPath, { readOnly: true })
      try {
        await backup(source, databasePath, {
          rate: 100,
          ...(onProgress ? { progress: onProgress } : {}),
        })
      } finally {
        source.close()
      }
      await fs.chmod(databasePath, 0o600)
      const snapshot = new DatabaseSync(databasePath, { readOnly: true })
      let rows
      try {
        integrity(snapshot)
        rows = proofRows(snapshot)
      } finally {
        snapshot.close()
      }
      await ensureDirectory(path.join(staging, 'uploads'))
      const files = []
      for (const row of rows) {
        const input = proofPath(uploadDir, row.id),
          output = proofPath(path.join(staging, 'uploads'), row.id)
        const state = await regularFile(input)
        if (state.size !== row.bytes) fail('源材料大小与数据库不一致：' + row.id)
        await fs.copyFile(input, output, constants.COPYFILE_EXCL)
        await fs.chmod(output, 0o600)
        files.push({ id: row.id, bytes: row.bytes, sha256: await digest(output) })
      }
      const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        node: process.versions.node,
        database: {
          bytes: (await fs.stat(databasePath)).size,
          sha256: await digest(databasePath),
        },
        files,
      }
      await fs.writeFile(
        path.join(staging, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      )
      await verifyBundle(staging)
      await fs.rename(staging, destination)
      return { directory: destination, files: files.length }
    } catch (error) {
      await removeOwnedStaging(backupDir, staging)
      throw error
    }
  })
}
async function restoreBundle({ bundle, dbPath, uploadDir }) {
  if (typeof backup !== 'function') fail('恢复需要 Node.js 22.16.0 或更高版本')
  dbPath = absolute(dbPath, '恢复 DB_PATH')
  uploadDir = absolute(uploadDir, '恢复 UPLOAD_DIR')
  if ((await exists(dbPath)) || (await exists(uploadDir)))
    fail('恢复只允许写入全新的数据库文件和材料目录，禁止覆盖现有数据')
  bundle = absolute(bundle, '备份目录')
  return withVerifiedBundle(bundle, async (verified) => {
    await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    await fs.mkdir(path.dirname(uploadDir), { recursive: true, mode: 0o700 })
    return withMaintenanceLock(dbPath, async () => {
      if ((await exists(dbPath)) || (await exists(uploadDir))) fail('恢复目标已存在')
      await fs.mkdir(uploadDir, { mode: 0o700 })
      const temporaryDatabase = dbPath + '.restore-' + crypto.randomBytes(8).toString('hex')
      let databasePublished = false
      try {
        for (const file of verified.manifest.files) {
          const input = proofPath(path.join(bundle, 'uploads'), file.id),
            output = proofPath(uploadDir, file.id)
          await fs.copyFile(input, output, constants.COPYFILE_EXCL)
          await fs.chmod(output, 0o600)
          if ((await digest(output)) !== file.sha256) fail('恢复材料校验失败')
        }
        // 恢复消费刚刚核验的相同字节，不重新打开可能已被替换的备份源库。
        await fs.copyFile(verified.databasePath, temporaryDatabase, constants.COPYFILE_EXCL)
        const restored = new DatabaseSync(temporaryDatabase, { readOnly: true })
        try {
          integrity(restored)
          const rows = proofRows(restored),
            expected = new Map(verified.manifest.files.map((file) => [file.id, file.bytes]))
          if (
            rows.length !== expected.size ||
            rows.some((row) => expected.get(row.id) !== row.bytes)
          )
            fail('恢复数据库与材料清单不一致')
        } finally {
          restored.close()
        }
        await fs.chmod(temporaryDatabase, 0o600)
        if (
          (await fs.stat(temporaryDatabase)).size !== verified.manifest.database.bytes ||
          (await digest(temporaryDatabase)) !== verified.manifest.database.sha256
        )
          fail('恢复数据库校验值不匹配')
        // link 创建目标时具有排他性，即使目标在预检后出现也不覆盖。
        await fs.link(temporaryDatabase, dbPath)
        databasePublished = true
        await fs.unlink(temporaryDatabase)
        return { database: dbPath, uploads: uploadDir, files: verified.files }
      } catch (error) {
        await fs.unlink(temporaryDatabase).catch((failure) => {
          if (failure.code !== 'ENOENT') throw failure
        })
        if (!databasePublished) await fs.rm(uploadDir, { recursive: true, force: true })
        throw error
      }
    })
  })
}
async function restoreTrashFile(root, trash, id) {
  const input = proofPath(trash, id),
    output = proofPath(root, id)
  await regularFile(input)
  if (await exists(output)) {
    await regularFile(output)
    if ((await digest(input)) !== (await digest(output)))
      fail('清理恢复发生文件冲突，请人工核对：' + id)
  } else {
    await fs.copyFile(input, output, constants.COPYFILE_EXCL)
  }
  await fs.unlink(input)
}
async function cleanup({ db, uploadDir, now = Date.now(), orphanDays = 7 }) {
  uploadDir = absolute(uploadDir, 'UPLOAD_DIR')
  if (!Number.isInteger(orphanDays) || orphanDays < 7) fail('未使用材料至少保留 7 天')
  await ensureDirectory(uploadDir)
  const trash = path.join(uploadDir, '.maintenance-trash')
  await ensureDirectory(trash)
  const hasSubmissionHistory = db
    .prepare('PRAGMA table_info(proof_files)')
    .all()
    .some((column) => column.name === 'ever_submitted')
  const result = {
    sessionsDeleted: 0,
    orphanRowsDeleted: 0,
    untrackedFilesDeleted: 0,
    filesDeleted: 0,
    filesRecovered: 0,
    trashRemaining: 0,
    metadataCleanupSkipped: !hasSubmissionHistory,
  }
  // 恢复上次进程中断时尚未提交的移动；提交后的残留则可安全删除。
  for (const id of await fs.readdir(trash)) {
    if (!PROOF_ID.test(id)) fail('清理隔离目录包含未知文件，请人工核对')
    if (db.prepare('SELECT id FROM proof_files WHERE id=?').get(id)) {
      await restoreTrashFile(uploadDir, trash, id)
      result.filesRecovered++
    } else {
      await regularFile(proofPath(trash, id))
      await fs.unlink(proofPath(trash, id))
      result.filesDeleted++
    }
  }
  result.sessionsDeleted = db.prepare('DELETE FROM sessions WHERE expires<=?').run(now).changes
  while (hasSubmissionHistory) {
    const moved = []
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db
        .prepare(
          'SELECT id FROM proof_files WHERE ever_submitted=0 AND external_id IS NULL AND experience_id IS NULL AND created_at<? ORDER BY created_at,id LIMIT 10',
        )
        .all(now - orphanDays * DAY)
      if (!rows.length) {
        db.exec('COMMIT')
        break
      }
      for (const row of rows) {
        const input = proofPath(uploadDir, row.id),
          output = proofPath(trash, row.id)
        if (await exists(input)) {
          await regularFile(input)
          if (await exists(output)) fail('清理隔离文件冲突')
          await fs.rename(input, output)
          moved.push(row.id)
        }
        db.prepare(
          'DELETE FROM proof_files WHERE id=? AND ever_submitted=0 AND external_id IS NULL AND experience_id IS NULL AND created_at<?',
        ).run(row.id, now - orphanDays * DAY)
      }
      db.exec('COMMIT')
      result.orphanRowsDeleted += rows.length
    } catch (error) {
      let recoveryError
      for (const id of moved.reverse()) {
        try {
          await restoreTrashFile(uploadDir, trash, id)
        } catch (failure) {
          recoveryError = failure
        }
      }
      if (db.isTransaction) db.exec('ROLLBACK')
      if (recoveryError) fail('材料清理已回滚，但隔离文件尚待恢复：' + recoveryError.message)
      throw error
    }
    for (const id of moved) {
      try {
        await fs.unlink(proofPath(trash, id))
        result.filesDeleted++
      } catch (error) {
        if (error.code !== 'ENOENT') result.trashRemaining++
      }
    }
    await new Promise(setImmediate)
  }
  // 进程在写文件后、插入元数据前退出时可能留下无元数据文件。只处理应用随机编号、
  // 超过保留期的普通文件，未知文件名与目录不会被删除。
  for (const id of await fs.readdir(uploadDir)) {
    if (!PROOF_ID.test(id)) continue
    const input = proofPath(uploadDir, id),
      state = await regularFile(input)
    if (state.mtimeMs >= now - orphanDays * DAY) continue
    const output = proofPath(trash, id)
    let moved = false
    db.exec('BEGIN IMMEDIATE')
    try {
      if (db.prepare('SELECT id FROM proof_files WHERE id=?').get(id)) {
        db.exec('COMMIT')
        continue
      }
      if (await exists(output)) fail('无元数据材料的隔离文件冲突')
      await fs.rename(input, output)
      moved = true
      db.exec('COMMIT')
    } catch (error) {
      let recoveryError
      if (moved) {
        try {
          await restoreTrashFile(uploadDir, trash, id)
        } catch (failure) {
          recoveryError = failure
        }
      }
      if (db.isTransaction) db.exec('ROLLBACK')
      if (recoveryError) fail('无元数据材料清理已回滚，隔离文件尚待恢复：' + recoveryError.message)
      throw error
    }
    try {
      await fs.unlink(output)
      result.filesDeleted++
      result.untrackedFilesDeleted++
    } catch (error) {
      if (error.code !== 'ENOENT') result.trashRemaining++
    }
  }
  return result
}
function configuredPaths(environment = process.env) {
  return {
    dbPath: absolute(environment.DB_PATH, 'DB_PATH'),
    uploadDir: absolute(environment.UPLOAD_DIR, 'UPLOAD_DIR'),
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'verify' && args.length === 1) {
    const result = await verifyBundle(args[0])
    console.log(JSON.stringify({ verified: true, files: result.files }))
    return
  }
  if (command === 'restore' && args.length === 3) {
    console.log(
      JSON.stringify(await restoreBundle({ bundle: args[0], dbPath: args[1], uploadDir: args[2] })),
    )
    return
  }
  const config = configuredPaths()
  if (command === 'backup' && args.length <= 1) {
    console.log(
      JSON.stringify(
        await backupBundle({ ...config, backupDir: args[0] || process.env.BACKUP_DIR }),
      ),
    )
    return
  }
  if (command === 'cleanup' && args.length === 0) {
    await regularFile(config.dbPath)
    const result = await withMaintenanceLock(config.dbPath, async () => {
      // 只有写维护才初始化应用，使用当前业务 schema。
      const { db } = require('./server')
      try {
        return await cleanup({ db, uploadDir: config.uploadDir })
      } finally {
        db.close()
      }
    })
    console.log(JSON.stringify(result))
    return
  }
  fail(
    '用法：maintenance.js backup [备份根目录] | verify <备份目录> | restore <备份目录> <新数据库路径> <新材料目录> | cleanup',
  )
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
module.exports = {
  backupBundle,
  verifyBundle,
  restoreBundle,
  cleanup,
  withMaintenanceLock,
  configuredPaths,
}
