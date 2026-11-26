// 點擊回歸測試（需先 npx vite --port 5173）：node tests/ui/clicks.cjs
// 模擬真人點擊（按下→150ms→放開），在畫面持續重繪的區塊測試是否點得到（pitfalls #12）
const { chromium } = require('playwright');
// 模擬真人點擊：按下 → 停 150ms → 放開（期間畫面持續重繪）
async function slowClick(p, sel) {
  const el = await p.$(sel);
  if (!el) return false;
  const box = await el.boundingBox();
  if (!box) return false;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(150);
  await p.mouse.up();
  return true;
}
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 912 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const res = {};
  // 1. 期權頁：點 T 字報價的價格 → 右側明細要換成該合約
  await p.goto('http://localhost:5173/?demo=1#/options'); await p.waitForTimeout(4000);
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const side = i % 2 ? 'P' : 'C';
    let code = null, box = null;
    for (let tries = 0; tries < 10 && !box; tries++) {
      const rows = await p.$$(`#chain-body td.px[data-side="${side}"]`);
      const target = rows[3 + i];
      code = await target.getAttribute('data-code').catch(() => null);
      box = await target.boundingBox().catch(() => null);
    }
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down(); await p.waitForTimeout(150); await p.mouse.up();
    await p.waitForTimeout(400);
    const sel = await p.$eval('#chain-body td.px.sel', e => e.dataset.code).catch(() => '');
    if (sel === code) ok++;
  }
  res.options = `${ok}/10`;
  // 2. 總覽：點權值股 → 跳到個股頁
  ok = 0;
  for (let i = 0; i < 5; i++) {
    await p.goto('http://localhost:5173/?demo=1#/overview'); await p.waitForTimeout(3500);
    await slowClick(p, `#ov-heavy tr[data-code]:nth-child(${i + 1})`);
    await p.waitForTimeout(600);
    if ((await p.evaluate(() => location.hash)).startsWith('#/stocks/')) ok++;
  }
  res.overviewHeavy = `${ok}/5`;
  // 3. 商品頁：切頁籤、點小卡
  await p.goto('http://localhost:5173/?demo=1#/products'); await p.waitForTimeout(4000);
  ok = 0;
  for (const t of ['fut', 'g1', 'hold', 'fut', 'g1']) {
    await slowClick(p, `.pd-tab[data-tab="${t}"]`); await p.waitForTimeout(500);
    if (await p.$(`.pd-tab.on[data-tab="${t}"]`)) ok++;
  }
  res.productTabs = `${ok}/5`;
  // 4. 頁籤切換
  ok = 0;
  for (const t of ['overview', 'account', 'products', 'options', 'stocks']) {
    await slowClick(p, `#tabs a[data-id="${t}"]`); await p.waitForTimeout(1500);
    if (await p.$(`#tabs a.on[data-id="${t}"]`)) ok++;
  }
  res.headerTabs = `${ok}/5`;
  // 5. 帳務頁（沒有期權部位時到期損益圖顯示提示文字）：頁籤與期間按鈕都要點得到（pitfalls #17）
  ok = 0;
  for (const t of ['overview', 'account', 'products', 'account', 'options']) {
    if (t === 'account' || ok === 0) { await p.goto('http://localhost:5173/?demo=1&nopos=1#/account'); await p.waitForTimeout(3500); }
    await slowClick(p, `#tabs a[data-id="${t}"]`); await p.waitForTimeout(1200);
    if (await p.$(`#tabs a.on[data-id="${t}"]`)) ok++;
  }
  res.accountNoPosTabs = `${ok}/5`;
  await p.goto('http://localhost:5173/?demo=1&nopos=1#/account'); await p.waitForTimeout(3500);
  await slowClick(p, '.rl-ctl button[data-r="week"]'); await p.waitForTimeout(800);
  res.accountRangeBtn = (await p.$('.rl-ctl button.on[data-r="week"]')) ? 'ok' : 'FAIL';
  console.log(res, errs);
  await b.close();
})();
