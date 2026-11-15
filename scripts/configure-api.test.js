const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { validateApiUrl, replaceApiBase, configure } = require('./configure-api')

test('生产地址仅允许 HTTPS，内网 HTTP 必须明确选择开发模式', () => {
  assert.equal(validateApiUrl('https://training.example.edu.cn/'), 'https://training.example.edu.cn')
  assert.equal(validateApiUrl('http://10.29.1.2:3000', { dev: true }), 'http://10.29.1.2:3000')
  for (const value of ['http://10.29.1.2:3000', 'https://user:secret@example.edu.cn', 'https://example.edu.cn/api', 'https://example.edu.cn?token=secret', 'https://example.edu.cn#token', 'https://example.edu.cn:444'])
    assert.throws(() => validateApiUrl(value))
  assert.throws(() => validateApiUrl('http://public.example.edu.cn', { dev: true }))
})

test('精确替换 API_BASE，保留其余内容和换行，不修改歧义文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'training-api-config-'))
  const file = path.join(root, 'store.js')
  try {
    const original = "// 调试地址\r\nconst API_BASE = 'http://127.0.0.1:3000'\r\nconst other = 'unchanged'\r\n"
    await fs.writeFile(file, original)
    assert.equal(await configure(file, 'https://training.example.edu.cn'), 'https://training.example.edu.cn')
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('http://127.0.0.1:3000', 'https://training.example.edu.cn'))
    assert.throws(() => replaceApiBase('const API_BASE = variable', 'https://example.edu.cn'), /仅存在/)
    assert.throws(() => replaceApiBase("const API_BASE = 'x'\nconst API_BASE = 'y'", 'https://example.edu.cn'), /仅存在/)
    assert.deepEqual(await fs.readdir(root), ['store.js'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
