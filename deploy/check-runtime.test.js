const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
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
