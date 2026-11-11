// 用 headless Edge（CDP）打开 mock 宿主页面，把关键界面走一遍并截图 + 断言。
// 用法：
//   1) 先起 mock 宿主：node tools/dev/mock-host.mjs 4300
//   2) 再起无头 Edge（本脚本**不**负责启动浏览器：进程关系更可控）：
//      msedge --headless=new --disable-gpu --remote-debugging-port=9333 --user-data-dir=<临时目录> about:blank
//   3) node tools/dev/screenshot.mjs <输出目录> [页面URL]
// 产物：
//   01-initial        挂件本体
//   02-ds-bubble      主显示 = DS 余额（默认）
//   03-menu           菜单（含「显示数据源」与「Magpie 用量」两行）
//   04-magpie-bubble  主显示切到 Magpie（剩余额度 + 剩余% + 今日折算）
//   05-magpie-window  Magpie 统计窗口（额度 / 四段用量 / 按模型 / 按 agent）
//   06-about          关于 / 自检（含 Magpie 统计行）
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2] || '_dl/shots'
const URL = process.argv[3] || 'http://127.0.0.1:4300/'
const PORT = Number(process.env.DSHW_CDP_PORT || 9333)
fs.mkdirSync(OUT, { recursive: true })

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

// 真实鼠标点击（Chromium 会同时派发 pointer 事件），鲸鱼用命中检测，必须走真事件
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(500)
}
async function whalePoint() {
  return await evaluate("(function(){var i=document.querySelector('.dshwv-img');if(!i)return null;var r=i.getBoundingClientRect();return {x:Math.round(r.left+r.width*0.55),y:Math.round(r.top+r.height*0.6)}})()")
}
async function bubbleText() {
  return await evaluate("(function(){var q=function(s){var e=document.querySelector(s);return e?e.textContent:''};var n=document.querySelectorAll('.dshwv-label').length;return {label:q('.dshwv-label'),amount:q('.dshwv-amount'),hint:q('.dshwv-hint'),labelNodes:n}})()")
}
async function clickBySelector(sel) {
  const p = await evaluate("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()")
  if (!p) return false
  await clickAt(p.x, p.y)
  return true
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: URL })
await sleep(3500)

console.log('widget mounted:', await evaluate("!!document.querySelector('.dshwv-root')"))
await shot('01-initial')

// ① 默认数据源（DS 余额）：点鲸鱼弹泡泡
const wp = await whalePoint()
if (wp) await clickAt(wp.x, wp.y)
console.log('bubble(deepseek):', JSON.stringify(await bubbleText()))
await shot('02-ds-bubble')

// ② 开菜单（再点一次鲸鱼会收起泡泡；直接用 ☰）
await clickBySelector('.dshwv-menu-btn')
await sleep(700)
console.log('menu open:', await evaluate("(function(){var m=document.querySelector('.dshwv-menu');return !!(m&&m.classList.contains('dshwv-menu-open'))})()"))
console.log('menu source row:', await evaluate("(function(){var b=document.querySelector('[data-dshw=\"src-magpie\"]');if(!b)return 'no btn';return b.parentNode.parentNode.textContent})()"))
await shot('03-menu')

// ③ 切到 Magpie 数据源
const switched = await clickBySelector('[data-dshw="src-magpie"]')
console.log('switch to magpie clicked:', switched)
await sleep(2600)
// 关菜单（点 ☰），再点鲸鱼看主显示
await clickBySelector('.dshwv-menu-btn')
await sleep(400)
const wp2 = await whalePoint()
if (wp2) await clickAt(wp2.x, wp2.y)
console.log('bubble(magpie):', JSON.stringify(await bubbleText()))
await shot('04-magpie-bubble')

// ④ Magpie 统计窗口
await clickBySelector('.dshwv-menu-btn')
await sleep(600)
await clickBySelector('[data-dshw="magpie-open"]')
await sleep(2600)
console.log('magpie window text:', String(await evaluate("(function(){var m=document.querySelector('.dshwv-magpie-mask');return m?m.innerText:'no mask'})()")).slice(0, 1200))
await shot('05-magpie-window')
await evaluate("(function(){var b=document.querySelector('.dshwv-magpie-mask .dshwv-usage-close');if(b)b.click();return 'closed'})()")
await sleep(300)

// ⑤ 关于 / 自检
await evaluate("(function(){var v=document.querySelector('.dshwv-ver');if(!v)return 'no ver';v.click();return 'clicked'})()")
await sleep(2200)
const aboutText = await evaluate("(function(){var a=document.querySelector('.dshwv-about');if(!a)return 'no about';return a.innerText})()")
console.log('about magpie lines:', String(aboutText).split('\n').filter((l) => /Magpie/.test(l)).join(' | ') || '(未找到)')
await shot('06-about')

console.log('widget console errors:', events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').length)
ws.close()
process.exit(0)
