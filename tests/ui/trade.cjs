// 下單頁（模擬）回歸測試：先跑 npx vite --port 5173
// 1. 下單防堵：fetch／XHR／sendBeacon／EventSource 連下單路徑都必須在送出前被擋（網路層完全看不到請求）
// 2. 雙擊價位階梯 → 產生模擬委託；點自己的委託數量 → 刪單
// 3. 1920×912 不需捲動
const { chromium } = require('playwright');
async function dbl(p, sel) {
  const box = await (await p.$(sel)).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  for (let i = 0; i < 2; i++) { await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(60); await p.mouse.up(); await p.waitForTimeout(90); }
}
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 912 } });
  const errs = [], orderReqs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('request', (r) => { if (/\/api\/.*(order|place_|cancel_|update_(price|qty)|trade)/i.test(r.url())) orderReqs.push(r.url()); });
  await p.clock.install({ time: new Date('2026-11-26T03:30:00Z') }); await p.clock.resume();
  await p.goto('http://localhost:5173/?demo=1#/trade/2330');
  await p.evaluate(() => localStorage.removeItem('mw.simOrders'));
  await p.reload(); await p.waitForTimeout(4500);
  const res = {};
  // 1. 防堵
  res.guard = await p.evaluate(async () => {
    const out = {};
    try { await fetch('/api/v1/order/place_order', { method: 'POST', body: '{}' }); out.fetch = 'SENT'; } catch (e) { out.fetch = e.name; }
    try { await fetch('/api/v1/Order/cancel_order'); out.fetchCase = 'SENT'; } catch (e) { out.fetchCase = e.name; }
    try { await fetch('/api/v1/%6Frder/x'); out.fetchEnc = 'SENT'; } catch (e) { out.fetchEnc = e.name; }
    try { const x = new XMLHttpRequest(); x.open('POST', '/api/v1/order/update_price'); x.send('{}'); out.xhr = 'SENT'; } catch (e) { out.xhr = e.name; }
    try { navigator.sendBeacon('/api/v1/order/place_order', '{}'); out.beacon = 'SENT'; } catch (e) { out.beacon = e.name; }
    try { new EventSource('/api/v1/stream/subscribe_trade'); out.es = 'SENT'; } catch (e) { out.es = e.name; }
    const f = () => 0;
    try { window.fetch = f; } catch { /* 嚴格模式會丟錯 */ }
    out.overwrite = window.fetch === f ? 'REPLACED' : 'locked';
    out.normal = (await fetch('/api/v1/info').then(() => 'ok', () => 'fail'));
    return out;
  });
  // 2. 模擬下單：雙擊買一價位（左半）
  const before = await p.$$eval('#td-orders tr', (e) => e.length);
  await dbl(p, '.td-row:nth-child(8) .td-bv');
  await p.waitForTimeout(800);
  res.msg = await p.$eval('#td-msg', (e) => e.textContent);
  res.orders = (await p.$$eval('#td-orders tr', (e) => e.length)) - before;
  // 低於市價的買單＝掛單，再點委託數量刪單
  const rows = await p.$$eval('.td-row', (e) => e.length);
  await dbl(p, `.td-row:nth-child(${rows - 1}) .td-bv`); await p.waitForTimeout(800);
  res.working = await p.$$eval('#td-orders tr.td-o-working', (e) => e.length);
  const working = await p.$('.td-my em[data-cxl]');
  if (working) { await working.click(); await p.waitForTimeout(800); }
  res.cancelled = await p.$$eval('#td-orders tr.td-o-cancelled', (e) => e.length);
  // 現股賣出超過庫存要擋
  await p.click('#td-cond button[data-c="cash"]'); await p.fill('#td-n', '50');
  await dbl(p, '.td-row:nth-child(3) .td-av'); await p.waitForTimeout(600);
  res.oversell = await p.$eval('#td-msg', (e) => e.textContent);
  res.layout = await p.evaluate(() => ({ pageH: document.documentElement.scrollHeight, ladderRows: document.querySelectorAll('.td-row').length }));
  await p.screenshot({ path: 'trade-1920x912.png' });
  res.orderRequestsSeenOnNetwork = orderReqs;
  console.log(JSON.stringify(res, null, 1), errs);
  const g = res.guard;
  const fail = Object.entries(g).filter(([k, v]) => (k === 'normal' ? v !== 'ok' : k === 'overwrite' ? v !== 'locked' : v !== 'OrderBlockedError'))
    .map(([k]) => 'guard.' + k);
  if (orderReqs.length) fail.push('network');
  if (res.orders < 1 || res.working < 1 || res.cancelled < 1) fail.push('sim');
  if (res.layout.pageH > 912) fail.push('layout');
  console.log(fail.length ? '✖ FAIL ' + fail.join(',') : '✓ PASS');
  if (fail.length) process.exitCode = 1;
  await b.close();
})();
