// 手機看盤用的「唯讀轉接站」
//
//   手機 ──▶ 這支程式（0.0.0.0:5180，需密碼）──▶ shioaji server（127.0.0.1:8080）
//
// - 只放行看盤與帳務查詢的 API（商品檔、快照、K 線、即時行情、帳務唯讀）；下單與設定一律回 403
// - 第一次連線要輸入密碼（.env 的 MW_PASSWORD），之後 30 天內免輸入
// - 不需要安裝任何套件，只用 Node.js 內建模組
//
// 用法：在專案資料夾執行  npm run phone
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MW_PORT || 5180);
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.MW_UPSTREAM_PORT || 8080) };

// ── 讀設定 ──────────────────────────────────────────────
function readDotEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const PASSWORD = process.env.MW_PASSWORD || readDotEnv().MW_PASSWORD || '';
// 沒設密碼 → 只開放這台電腦（127.0.0.1）使用：同步自選、代抓法人買賣超；手機連不進來
const LOCAL_ONLY = PASSWORD.length < 6;
if (LOCAL_ONLY) console.log('\n（.env 沒有 MW_PASSWORD：只開放這台電腦使用，手機無法連線）');
const INDEX = join(ROOT, 'dist', 'index.html');
if (!existsSync(INDEX)) {
  console.error('\n✖ 找不到 dist/index.html，請先執行 npm run build（或 npm run deploy）。\n');
  process.exit(1);
}

const STORE = join(ROOT, 'mywatch-store.json');
const isLocal = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

const TOKEN = createHash('sha256').update('mywatch-phone:' + PASSWORD).digest('hex');
const COOKIE = 'mw_auth';

// ── 白名單：只允許看盤用的 API ──────────────────────────
const ALLOW = [
  ['GET', /^\/api\/v1\/info$/],
  ['GET', /^\/api\/v1\/data\/contracts(\/[^/?]+)*$/],
  ['POST', /^\/api\/v1\/data\/(snapshots|kbars|ticks|scanner)$/],
  ['POST', /^\/api\/v1\/stream\/(subscribe|unsubscribe)$/],
  ['GET', /^\/api\/v1\/stream\/data$/],
  // 帳務（唯讀查詢；使用者決定手機也能完整看帳務，見 docs/ai/requirements.md 第 1 輪）
  ['GET', /^\/api\/v1\/auth\/accounts$/],
  ['POST', /^\/api\/v1\/portfolio\/(account_balance|margin|position_unit|position_detail|profit_loss|profit_loss_detail|profitloss_sum|settlements|trading_limits)$/],
];
const allowed = (method, path) =>
  // 只接受單純的路徑字元，擋掉 ../、編碼字元（%2e 等）、反斜線與 // 這類繞過白名單的寫法
  /^[A-Za-z0-9_\-/.]+$/.test(path) && !/\.\.|\/\//.test(path) &&
  ALLOW.some(([m, re]) => m === method && re.test(path));

// ── 三大法人買賣超（證交所 T86＋櫃買），盤後資訊 ───────────
// 瀏覽器不能直接抓（對方沒開 CORS），由轉接站代抓。往回找最近有資料的交易日。
// 回傳 { date:'YYYY-MM-DD', rows:[{ code, name, mkt:'TSE'|'OTC', foreign, trust, dealer }] }（單位：股）
const instCache = new Map(); // date -> data（有資料的日期永久快取）
let instLatest = null;       // { at, data }
const n = (x) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const UA = { 'User-Agent': 'Mozilla/5.0 (mywatch)', Accept: 'application/json' };
async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function instOf(date) { // date: YYYYMMDD
  if (instCache.has(date)) return instCache.get(date);
  const tw = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALLBUT0999&response=json`);
  if (tw.stat !== 'OK' || !tw.data?.length) return null; // 假日或尚未公布
  const rows = tw.data.map((r) => ({ code: String(r[0]).trim(), name: String(r[1]).trim(), mkt: 'TSE',
    foreign: n(r[4]) + n(r[7]), trust: n(r[10]), dealer: n(r[11]) }));
  try {
    const d = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}`;
    const tp = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(d)}&response=json`);
    for (const r of tp.tables?.[0]?.data ?? []) {
      rows.push({ code: String(r[0]).trim(), name: String(r[1]).trim(), mkt: 'OTC', foreign: n(r[10]), trust: n(r[13]), dealer: n(r[22]) });
    }
  } catch (e) { console.log('[法人] 櫃買抓取失敗', e.message); }
  const data = { date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`, rows };
  instCache.set(date, data);
  return data;
}
async function instLatestData() {
  if (instLatest && Date.now() - instLatest.at < 10 * 60_000) return instLatest.data;
  const now = new Date(Date.now() + 8 * 3600_000);
  for (let i = 0; i < 10; i++) {
    const d = new Date(now.getTime() - i * 86400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const data = await instOf(d.toISOString().slice(0, 10).replace(/-/g, ''));
    if (data) { instLatest = { at: Date.now(), data }; return data; }
    await new Promise((r) => setTimeout(r, 400)); // 證交所有頻率限制
  }
  throw new Error('最近 10 天都查不到三大法人資料');
}
// 從 shioaji server（127.0.0.1:8080/apps/mywatch/）開啟的頁面也能呼叫：只允許本機來源跨站讀取
const localOrigin = (o) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o || '');

// ── 小工具 ──────────────────────────────────────────────
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => safeEq(cookies(req)[COOKIE] || '', TOKEN);

const fails = new Map(); // ip -> { n, until }
function locked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function failed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 5 * 60_000; f.n = 0; }
  fails.set(ip, f);
}

function loginPage(msg = '') {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>期權看盤・登入</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#e6edf3;
font:16px system-ui,"Noto Sans TC","PingFang TC",sans-serif}form{background:#161b22;border:1px solid #262d38;
border-radius:14px;padding:28px 24px;width:min(320px,88vw)}h1{font-size:20px;margin:0 0 18px}
input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:8px;border:1px solid #262d38}
input{background:#0e1116;color:#e6edf3;margin-bottom:12px}button{background:#f5b94a;color:#1a1405;border:0;font-weight:700}
p{color:#f0524f;font-size:14px;margin:10px 0 0}</style></head><body>
<form method="post" action="/login"><h1>期權看盤</h1>
<input type="password" name="password" placeholder="密碼" autocomplete="current-password" autofocus required>
<button>進入</button>${msg ? `<p>${msg}</p>` : ''}</form></body></html>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

// ── 轉發到 shioaji server ──────────────────────────────
function proxy(req, res) {
  const headers = { ...req.headers };
  // shioaji server 只接受本機來源：改寫 Host、拿掉瀏覽器帶的 Origin/Referer 與我們自己的 cookie
  headers.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
  delete headers.origin;
  delete headers.referer;
  delete headers.cookie;
  const up = http.request({ ...UPSTREAM, method: req.method, path: req.url, headers }, (ur) => {
    const h = { ...ur.headers };
    if (String(h['content-type'] || '').includes('text/event-stream')) {
      h['cache-control'] = 'no-cache';
      h['x-accel-buffering'] = 'no';
      res.socket?.setNoDelay(true);
    }
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) send(res, 502, JSON.stringify({ message: '連不到 shioaji server，請確認它在電腦上執行中' }), 'application/json');
    else res.end();
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

// ── 主程式 ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || '';
  const path = (req.url || '/').split('?')[0];

  if (path === '/login' && req.method === 'POST') {
    if (locked(ip)) return send(res, 429, loginPage('嘗試次數太多，請 5 分鐘後再試'));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(body).get('password') || '';
      if (!safeEq(pw, PASSWORD)) {
        failed(ip);
        console.log(`[登入失敗] ${ip}`);
        return send(res, 401, loginPage('密碼錯誤'));
      }
      fails.delete(ip);
      console.log(`[登入成功] ${ip}`);
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Strict`,
      });
      res.end();
    });
    return;
  }

  // 三大法人買賣超（唯讀、只給本機）
  if (path === '/mw/inst' && isLocal(ip)) {
    const cors = localOrigin(req.headers.origin) ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', { ...cors, 'Access-Control-Allow-Methods': 'GET' });
    instLatestData()
      .then((d) => send(res, 200, JSON.stringify(d), 'application/json', cors))
      .catch((e) => send(res, 502, JSON.stringify({ message: '抓取證交所／櫃買資料失敗：' + e.message }), 'application/json', cors));
    return;
  }

  // 沒設密碼時只服務本機
  if (LOCAL_ONLY && !isLocal(ip)) return send(res, 403, '只開放這台電腦使用（.env 沒有設定 MW_PASSWORD）', 'text/plain; charset=utf-8');

  // 從電腦本機開啟免密碼；手機（區網、Tailscale）需要密碼
  if (!isLocal(ip) && !authed(req)) {
    if (path.startsWith('/api/')) return send(res, 401, '{"message":"unauthorized"}', 'application/json');
    return send(res, 200, loginPage());
  }

  // 設定同步：GET 讀取、PUT 整份覆寫（JSON，上限 512KB）
  if (path === '/mw/store') {
    if (req.method === 'GET') {
      return send(res, 200, existsSync(STORE) ? readFileSync(STORE) : '{}', 'application/json');
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          JSON.parse(body);
          writeFileSync(STORE + '.tmp', body);
          renameSync(STORE + '.tmp', STORE);
          send(res, 200, '{"ok":true}', 'application/json');
        } catch { send(res, 400, '{"message":"bad json"}', 'application/json'); }
      });
      return;
    }
  }

  if (path === '/' || path === '/index.html') {
    return send(res, 200, readFileSync(INDEX));
  }
  if (path.startsWith('/api/')) {
    if (!allowed(req.method, path)) {
      console.log(`[已阻擋] ${req.method} ${path}`);
      return send(res, 403, '{"message":"手機轉接站只開放看盤功能"}', 'application/json');
    }
    return proxy(req, res);
  }
  send(res, 404, 'Not found', 'text/plain');
});
server.requestTimeout = 0; // SSE 串流需要長連線
server.headersTimeout = 30_000;

server.listen(PORT, LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0', () => {
  const ips = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list || []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, ip: i.address })));
  console.log('\n📱 手機看盤轉接站已啟動（開放看盤與帳務查詢，下單已封鎖）\n');
  for (const { name, ip } of LOCAL_ONLY ? [] : ips) {
    const tag = ip.startsWith('100.') ? '（Tailscale，出門在外用這個）' : '（同一個 Wi-Fi 用這個）';
    console.log(`   http://${ip}:${PORT}   ${tag}  [${name}]`);
  }
  console.log(`   http://localhost:${PORT}   （這台電腦用這個，免密碼；自選股與手機同步）`);
  console.log('\n   電腦和 shioaji server 要保持開著；按 Ctrl+C 結束。\n');
});
