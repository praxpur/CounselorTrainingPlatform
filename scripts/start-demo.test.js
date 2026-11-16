const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { startDemo, prepareDirectory, prepareAccounts } = require('./start-demo')
const temporary = path.resolve(__dirname, '../tmp')

test('演示入口只准备管理员，重复准备保留自行创建的用户和活动', async () => {
  await fs.mkdir(temporary, { recursive: true })
  const directory = await fs.mkdtemp(path.join(temporary, 'demo-launcher-test-'))
  const apiFile = path.join(directory, 'store.js')
  await fs.writeFile(apiFile, "const API_BASE = 'http://127.0.0.1:3000'\n")
  let application
  try {
    application = await startDemo({ directory, port: 0, apiFile, quiet: true })
    const login = async id => {
      const response = await fetch(application.address + '/api/auth/login', { method: 'POST',
        body: JSON.stringify({ id, password: 'Demo12345678!' }) })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.mustChangePassword, false)
      return result
    }
    assert.equal((await login('admin')).user.role, 'admin')
    assert.equal(application.db.prepare("SELECT COUNT(*) n FROM users WHERE id='user'").get().n, 0)
    await require('../server/roster').importRoster(application.db, [{ id: 'user', name: '测试用户', department: '测试学院', role: 'counselor', initialPassword: 'Test12345678!' }])
    application.db.prepare("INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,credit_hours,created_at) VALUES('演示记录','','',1,2,0,1.5,1)").run()
    await prepareAccounts(application.db)
    assert.equal(application.db.prepare("SELECT name FROM users WHERE id='user'").get().name, '测试用户')
    assert.equal(application.db.prepare('SELECT COUNT(*) n FROM activities').get().n, 1)
    await login('admin')
    assert.equal(process.env.DB_PATH, path.join(directory, 'training.db'))
    assert.match(await fs.readFile(apiFile, 'utf8'), new RegExp(application.address.replaceAll('.', '\\.')))
  } finally {
    if (application) await application.close()
    assert.ok(path.relative(temporary, directory).startsWith('demo-launcher-test-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('未知已有数据库不会被演示入口接管', async () => {
  const directory = await fs.mkdtemp(path.join(temporary, 'demo-launcher-guard-'))
  try {
    await fs.writeFile(path.join(directory, 'training.db'), 'untouched')
    await assert.rejects(prepareDirectory(directory), /未知数据库/)
    assert.equal(await fs.readFile(path.join(directory, 'training.db'), 'utf8'), 'untouched')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('不会复用进程里已加载的后端或改写它的数据库配置', async () => {
  const previous = process.env.DB_PATH
  await assert.rejects(startDemo(), /必须独立启动/)
  assert.equal(process.env.DB_PATH, previous)
})

test('Windows CMD入口使用CRLF，在含空格和中文的路径下可启动Node', { skip: process.platform !== 'win32' }, async () => {
  const source=path.resolve(__dirname,'../demo.cmd'),contents=await fs.readFile(source,'ascii')
  assert.equal(contents.replaceAll('\r\n','').includes('\n'),false)
  const directory=await fs.mkdtemp(path.join(temporary,'cmd launcher test-'))
  try{
    await fs.mkdir(path.join(directory,'scripts'))
    await fs.copyFile(source,path.join(directory,'demo.cmd'))
    await fs.writeFile(path.join(directory,'scripts/start-demo.js'),"console.log('DEMO_LAUNCHER_OK')\n")
    const execute=require('node:util').promisify(require('node:child_process').execFile)
    const result=await execute('cmd.exe',['/d','/c',path.join(directory,'demo.cmd')],{timeout:15000,encoding:'utf8'})
    assert.match(result.stdout,/DEMO_LAUNCHER_OK/)
  }finally{
    assert.ok(path.relative(temporary,directory).startsWith('cmd launcher test-'))
    await fs.rm(directory,{recursive:true,force:true})
  }
})
