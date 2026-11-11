// 本地试运行壳（不依赖 DSH 宿主）：用最小 mock 的 ctx 把 lib/index.js 的 apply() 跑起来，
// 把它注册的 /dsh-whale/* 路由挂到一个本地 HTTP 端口上，供本地验证 / 截图 / 手工点开面板。
//
// 用法：
//   node tools/dev/mock-host.mjs [port]        # 默认 4300，打开 http://127.0.0.1:4300/
//   （页面已内置挂件挂载所需的「主聊天界面」特征：#root + composer，见 dshwIsChatRoot）
// 提示：拿不到真实余额是正常的（这里是假 ctx，没有 DSH 凭据服务）；Magpie 那一块用的是本机真实数据。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.argv[2] || 4300)

const routes = []
const disposers = []
const ctx = {
  effect(fn) { try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (err) { console.error('effect:', err.message) } },
  on(name, fn) { return () => {} },
  inject(deps, cb) { cb(ctx) },
  get() { return null },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  credentials: {
    async resolve() { return { value: 'sk-fake-for-harness' } },
    async set() {},
  },
  webServer: {
    register(route) { routes.push(route); return () => {} },
    tapIndex(fn) { return () => {} },
  },
}

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const plugin = mod.default || mod
plugin.apply(ctx)

// 路由表（host 自己也用 connection 栅栏，这里没有 → 只走插件自带的回环校验，正好也是被测路径）
function findRoute(pathname) {
  for (const r of routes) {
    if (r.kind === 'exact' && r.path === pathname) return r
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const route = findRoute(url.pathname)
  if (route) {
    // 假 DeepSeek 余额（只为本地看界面）：真实 handler 拿不到 DSH 凭据服务，余额一定 401，
    // 那样"主显示 = DS 余额"这条路径在本地永远是红的。设 DSHW_MOCK_BALANCE=1 时保留真响应的
    // 其它字段（尤其 magpie），只把余额/今日已用换成假数据 —— 产品代码一行都不改。
    if (url.pathname === '/dsh-whale/balance.json' && process.env.DSHW_MOCK_BALANCE === '1') {
      const captured = []
      const fakeRes = {
        writeHead() {},
        end(body) { if (body) captured.push(String(body)) },
      }
      try { await route.handler(req, fakeRes) } catch (err) {}
      let base = {}
      try { base = JSON.parse(captured[0] || '{}') } catch (err) { base = {} }
      const merged = Object.assign({}, base, {
        ok: true, totalBalance: 42.18, currency: 'CNY',
        todayUsage: 1.23, todayUsageCurrency: 'CNY',
        usageLabel: '已观测消费', usageSource: 'balance-observed', isPeak: false,
        magpie: base.magpie || null,
      })
      delete merged.error
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(merged))
      return
    }
    try { await route.handler(req, res) } catch (err) {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }) }
      try { res.end('harness error: ' + String((err && err.message) || err)) } catch (e2) {}
    }
    return
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // 模拟 DSH 页面：挂件只会在「主聊天界面」挂载 —— 判据是 #root 里存在 composer
    // （`[data-composer-input]` / textarea 等，见 whale-widget.js 的 dshwIsChatRoot）。
    // 所以这里必须把这套最小 DOM 特征摆出来，否则挂件一行 DOM 都不会碰（这是它的设计，不是 bug）。
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>whale harness</title>'
      + '<style>html,body{margin:0;height:100%;background:#0f1526;font-family:system-ui,"Segoe UI",sans-serif}'
      + '#root{height:100%;display:flex;flex-direction:column}'
      + '.hd{padding:18px 24px;color:#8fa4d4;font-size:13px;border-bottom:1px solid #1e2942}'
      + '.msgs{flex:1;padding:18px 24px;color:#5c6b8f;font-size:12px}'
      + '.seat{margin:0 24px 24px;border:1px solid #1e2942;border-radius:10px;padding:10px}'
      + '.seat textarea{width:100%;height:64px;background:transparent;border:none;outline:none;color:#c9d6f5;'
      + 'font-size:13px;resize:none;font-family:inherit}'
      + '</style></head><body>'
      + '<div id="root"><div class="hd">whale-widget harness · 模拟 DSH 主聊天界面（#root + composer）</div>'
      + '<div class="msgs">（这里是对话区，仅用于占位）</div>'
      + '<div class="seat" data-composer-seat><div data-composer-card>'
      + '<textarea data-composer-input placeholder="假 composer：挂件靠它判断“这是主聊天界面”"></textarea>'
      + '</div></div></div>'
      + '<script defer src="/dsh-whale/widget.js"></script></body></html>'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found: ' + url.pathname)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock host listening on http://127.0.0.1:' + PORT)
  console.log('routes: ' + routes.map((r) => r.path).join(' '))
})
