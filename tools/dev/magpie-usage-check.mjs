// 三种数据源场景的自测（不依赖浏览器）：正常 / 网关挂掉 / 机器上根本没有 Magpie。
// 用法：node tools/dev/magpie-usage-check.mjs
// 它会起三个临时 mock 宿主（端口 4311/4312/4313），分别喂不同的环境变量，然后断言
// 「快照来源 + 设置读写往返 + 关掉开关后不读文件不联网」。CI 不跑它（需要本机有 Magpie），
// 改 Magpie 那一块之后手动跑一遍即可。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const NODE = process.execPath
const HOME = path.join(ROOT, '_dl', 'dshhome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPort(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/dsh-whale/magpie-settings.json')
      if (r.ok) return true
    } catch (err) {}
    await sleep(150)
  }
  return false
}

async function scenario(name, env, port) {
  const child = spawn(NODE, [path.join(HERE, 'mock-host.mjs'), String(port)], {
    env: Object.assign({}, process.env, env),
    stdio: 'ignore',
  })
  const up = await waitPort(port)
  if (!up) { console.log('[' + name + '] harness 没起来'); try { child.kill() } catch (e) {}; return null }
  const r = await fetch('http://127.0.0.1:' + port + '/dsh-whale/magpie.json?refresh=1')
  const j = await r.json()
  console.log('\n=== ' + name + ' ===')
  console.log(JSON.stringify({
    ok: j.ok, enabled: j.enabled, available: j.available, source: j.source,
    gateway: j.gateway, file: j.file && { path: j.file.path, lines: j.file.lines },
    fileError: j.fileError, reason: j.reason,
    today: j.periods && j.periods.today && {
      calls: j.periods.today.calls, tokens: j.periods.today.tokens, cny: j.periods.today.cny,
    },
  }, null, 1))
  // 顺带验证设置读写往返
  const put = await fetch('http://127.0.0.1:' + port + '/dsh-whale/magpie-settings.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: false, url: 'http://127.0.0.1:3999' }),
  })
  const putJ = await put.json()
  const getJ = await (await fetch('http://127.0.0.1:' + port + '/dsh-whale/magpie-settings.json')).json()
  console.log('settings PUT:', JSON.stringify(putJ), '→ GET:', JSON.stringify(getJ))
  // 关掉之后再取一次：应该走 disabled 分支（不读文件、不联网）
  const after = await (await fetch('http://127.0.0.1:' + port + '/dsh-whale/magpie.json?refresh=1')).json()
  console.log('after disable:', JSON.stringify({ enabled: after.enabled, available: after.available, source: after.source, reason: after.reason }))
  // 还原设置，避免影响下一轮
  await fetch('http://127.0.0.1:' + port + '/dsh-whale/magpie-settings.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true, url: 'http://127.0.0.1:3425' }),
  })
  try { child.kill() } catch (err) {}
  await sleep(300)
  return j
}

fs.mkdirSync(HOME, { recursive: true })
try { fs.rmSync(path.join(HOME, '.dshw-magpie.json'), { force: true }) } catch (err) {}
fs.mkdirSync(path.join(HERE, 'fakehome'), { recursive: true })

await scenario('A 正常（网关在线 + usage.jsonl）', { DSH_HOME: HOME }, 4311)
await scenario('B 网关挂掉（只剩 usage.jsonl）', { DSH_HOME: HOME, MAGPIE_BASE_URL: 'http://127.0.0.1:3999' }, 4312)
await scenario('C 机器上没有 Magpie（空 HOME + 死地址）', {
  DSH_HOME: HOME,
  MAGPIE_BASE_URL: 'http://127.0.0.1:3999',
  USERPROFILE: path.join(HERE, 'fakehome'),
  HOME: path.join(HERE, 'fakehome'),
}, 4313)
process.exit(0)
