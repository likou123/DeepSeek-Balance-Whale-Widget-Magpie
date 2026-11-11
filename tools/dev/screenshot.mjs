// 用 headless Edge（CDP）打开 mock 宿主页面，依次：截图 → 悬停 → 开菜单 → 开 Magpie 窗口 → 截图。
// 用法：
//   1) 先起 mock 宿主：node tools/dev/mock-host.mjs 4300
//   2) 再起无头 Edge（本脚本**不**负责启动浏览器：沙箱/CI 里进程关系更可控）：
//      msedge --headless=new --disable-gpu --remote-debugging-port=9333 --user-data-dir=<临时目录> about:blank
//   3) node tools/dev/screenshot.mjs <输出目录> [页面URL]
// 产物：01-initial/02-hover/03-menu/04-magpie-window/05-closed 五张 PNG + 控制台里的断言输出
// （widget 是否挂载、菜单行摘要、Magpie 窗口文本、前端 console error 数）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const OUT = process.argv[2] || '_dl/shots'
const URL = process.argv[3] || 'http://127.0.0.1:4300/'
const PORT = Number(process.env.DSHW_CDP_PORT || 9333)
fs.mkdirSync(OUT, { recursive: true })
// 注意：Edge 必须在外面先起来（沙箱里 node 直接 spawn 浏览器拿不到调试端口）。
//   Start-Process msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpTargets() {
  let lastErr = ''
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        console.log('CDP page target after ' + (i * 250) + 'ms')
        return page
      }
      lastErr = 'no page target (' + list.map((t) => t.type).join(',') + ')'
    } catch (err) { lastErr = String((err && err.cause && err.cause.message) || (err && err.message) || err) }
    if (i % 20 === 19) console.log('waiting for CDP… ' + lastErr)
    await sleep(250)
  }
  throw new Error('CDP not ready: ' + lastErr)
}

const page = await cdpTargets()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method) events.push(msg)
})
if (ws.readyState !== WebSocket.OPEN) {
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
}

function send(method, params) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v) },
      reject: (e) => { clearTimeout(t); reject(e) },
    })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result && r.result.value
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(OUT, name + '.png')
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('shot ->', file)
  return file
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: URL })
await sleep(3500)

// 页面是否加载了挂件
const loaded = await evaluate("!!document.querySelector('.dshwv-root')")
console.log('widget mounted:', loaded)
await shot('01-initial')

// 悬停鲸鱼 → 菜单按钮可见
await evaluate("(function(){var r=document.querySelector('.dshwv-root');if(!r)return 'no root';r.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));return 'hover ok'})()")
await sleep(400)
await shot('02-hover')

// 打开菜单
const menuOpened = await evaluate("(function(){var b=document.querySelector('.dshwv-menu-btn');if(!b)return 'no btn';b.click();return 'clicked'})()")
console.log('menu click:', menuOpened)
await sleep(900)
const menuVisible = await evaluate("(function(){var m=document.querySelector('.dshwv-menu');return !!(m && m.classList.contains('dshwv-menu-open'))})()")
console.log('menu open:', menuVisible)
const magpieRowText = await evaluate("(function(){var b=document.querySelector('[data-dshw=\"magpie-open\"]');if(!b)return 'no magpie btn';return b.parentNode.textContent})()")
console.log('magpie row:', magpieRowText)
await shot('03-menu')

// 打开 Magpie 用量窗口
const opened = await evaluate("(function(){var b=document.querySelector('[data-dshw=\"magpie-open\"]');if(!b)return 'no btn';b.click();return 'clicked'})()")
console.log('magpie open:', opened)
await sleep(2500)
const winText = await evaluate("(function(){var m=document.querySelector('.dshwv-magpie-mask');if(!m)return 'no mask';return m.innerText})()")
console.log('--- magpie window text ---')
console.log(String(winText).slice(0, 2500))
await shot('04-magpie-window')

// 关掉窗口，再截一张干净页面
await evaluate("(function(){var b=document.querySelector('.dshwv-magpie-mask .dshwv-usage-close');if(b)b.click();return 'closed'})()")
await sleep(400)
await shot('05-closed')
// 关窗后主菜单那一行应该已经拿到摘要（首次可能先显示「读取中…」，靠自动重试补上）
const rowAfter = await evaluate("(function(){var b=document.querySelector('[data-dshw=\"magpie-open\"]');if(!b)return 'no row';return b.parentNode.textContent})()")
console.log('magpie row after load:', rowAfter)

// 「关于 / 自检」面板：确认 Magpie 那一行也在里面（点菜单底部的版号）
await evaluate("(function(){var v=document.querySelector('.dshwv-ver');if(!v)return 'no ver';v.click();return 'clicked'})()")
await sleep(2200)
const aboutText = await evaluate("(function(){var a=document.querySelector('.dshwv-about');if(!a)return 'no about';return a.innerText})()")
const magpieLine = String(aboutText).split('\n').filter((l) => /Magpie/.test(l)).join(' | ')
console.log('about magpie line:', magpieLine || '(未找到)')
await shot('06-about')
console.log('widget console errors:', events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').length)

ws.close()
process.exit(0)
