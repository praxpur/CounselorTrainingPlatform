const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { validateProduction } = require('./check-runtime')
const good = { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000',
  DB_PATH: path.join(os.tmpdir(), 'private-training', 'training.db'),
  UPLOAD_DIR: path.join(os.tmpdir(), 'private-training', 'uploads'),
  BACKUP_DIR: path.join(os.tmpdir(), 'private-training-backups') }
test('生产预检拒绝开发登录、内存库、代码内数据目录及旧运行时', () => {
  assert.equal(validateProduction(good).valid, true)
  for (const overrides of [{ NODE_ENV: 'development' }, { ENABLE_DEV_LOGIN: '1' }, { HOST: '0.0.0.0' }, { DB_PATH: ':memory:' },
    { UPLOAD_DIR: path.resolve(__dirname, '../server/uploads') }, { BACKUP_DIR: '' }, { PORT: '0' }])
    assert.throws(() => validateProduction({ ...good, ...overrides }))
  assert.throws(() => validateProduction(good, '22.13.0', { backup() {} }))
  assert.throws(() => validateProduction(good, '24.0.0', {}))
})

test('代码目录的软链接或 junction 别名不能绕过数据路径预检', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'training-preflight-')))
  const alias = path.join(root, 'release-alias')
  try {
    fs.symlinkSync(path.resolve(__dirname, '..'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    for (const key of ['DB_PATH', 'UPLOAD_DIR', 'BACKUP_DIR']) {
      assert.throws(() => validateProduction({ ...good, [key]: path.join(alias, 'not-created-yet', 'private-data') }), /代码目录外/)
    }
    assert.throws(() => validateProduction({ ...good, DB_PATH: path.join(alias, 'server', 'package.json') }), /代码目录外/)
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias)
    assert.equal(fs.realpathSync(root), root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('代码外数据目录的合法链接及尚未创建的后缀仍可配置', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'training-preflight-')))
  const target = path.join(root, 'private-data'), alias = path.join(root, 'data-alias')
  try {
    fs.mkdirSync(target)
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(validateProduction({ ...good, DB_PATH: path.join(alias, 'future', 'training.db'),
      UPLOAD_DIR: path.join(alias, 'future', 'uploads'), BACKUP_DIR: path.join(alias, 'future', 'backups') }).valid, true)
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias)
    assert.equal(fs.realpathSync(root), root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
