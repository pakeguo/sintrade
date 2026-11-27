// 期權（F）帳務查詢次數回歸測試：先跑 npx vite --port 5173
// 期貨商限制查詢次數 → 期權帳務只能在每天 05:00、08:45、13:45、14:45 各查一次（docs/ai/decisions.md）。
// 用假時鐘從台北 08:30 開始，走過所有頁面與帳務按鈕、開第二個分頁，再把時間快轉過各時段，
// 檢查：每一輪只查 margin／position_unit／profit_loss 各 1 次；時段之間 0 次；閘門（core/fgate.ts）沒有擋到任何查詢。
const { chromium } = require('playwright');
const START = new Date('2026-11-26T00:30:00Z');   // 台北 08:30（週四）；走完所有頁面約 3 分鐘，仍在 08:45 之前
const MIN = 60_000;

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1920, height: 912 } });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.clock.install({ time: START });
  await p.goto('http://localhost:5173/?demo=1#/overview');
  await p.evaluate(() => { for (const k of ['acctF', 'acctFLock', 'rlF']) localStorage.removeItem('mw.' + k); });
  await p.reload();
  const F = async (pg = p) => pg.evaluate(() => {
    const c = globalThis.__pf ?? {};
    const f = Object.entries(c).filter(([k]) => k.startsWith('F:'));
    return { total: f.reduce((s, [, v]) => s + v, 0), detail: Object.fromEntries(f), blocked: globalThis.__fBlocked ?? 0 };
  });
  // 短時間逐一執行計時器；長時間用 fastForward 直接跳（每個計時器只觸發一次），再跑 30 秒讓帳務更新跑完
  const run = async (ms) => {
    if (ms <= 5 * MIN) { await p.clock.runFor(ms); return; }
    await p.clock.fastForward(ms - 30_000); await p.clock.runFor(30_000);
  };
  const res = {};

  // 1. 啟動＋走過所有頁面（08:30–08:34，不跨時段）
  await p.clock.runFor(4000);
  for (const [hash, act] of [
    ['#/products', async () => { await p.click('#pk-open'); await p.clock.runFor(1500); await p.keyboard.press('Escape'); }],
    ['#/stocks/2330', null], ['#/stocks/TXFL6', null], ['#/options', null],
    ['#/trade/2330', null], ['#/trade/TXFL6', null],
    ['#/account', async () => {
      for (const r of ['today', 'week', 'month', 'year']) { await p.click(`.rl-ctl button[data-r="${r}"]`); await p.clock.runFor(1500); }
      await p.selectOption('#fee-m', { index: 1 }); await p.clock.runFor(1500);
    }],
    ['#/overview', null],
  ]) {
    await p.evaluate((h) => { location.hash = h; }, hash);
    await p.clock.runFor(3000);
    if (act) await act();
    await p.clock.runFor(15_000);
  }
  res.startup = await F();

  // 2. 第二個分頁（同一個瀏覽器）：已有快取，不應再查
  const p2 = await ctx.newPage();
  await p2.clock.install({ time: new Date(START.getTime() + 3 * MIN) });
  await p2.goto('http://localhost:5173/?demo=1#/account');
  await p2.clock.runFor(20_000);
  res.secondTab = await F(p2);
  await p2.close();

  // 3. → 08:40 左右：時段之間不查
  await run(5 * MIN);
  res.before0845 = await F();
  // 4. 跨過 08:45 → 查 1 輪；之後到 13:44 都不查
  await run(10 * MIN);
  res.after0845 = await F();
  await run(4 * 60 * MIN + 45 * MIN);          // 到 13:35 左右
  res.before1345 = await F();
  await run(15 * MIN);                         // 跨 13:45（→ 13:50 左右）
  res.after1345 = await F();
  await run(60 * MIN);                         // 跨 14:45
  res.after1445 = await F();

  console.log(JSON.stringify(res, null, 1), errs.slice(0, 3));
  const round = 3;   // 每輪：margin、position_unit、profit_loss（今日）
  const fail = [];
  if (res.startup.total !== round) fail.push(`啟動應查 ${round} 次，實際 ${res.startup.total}`);
  if (res.secondTab.total !== 0) fail.push(`第二個分頁不應查詢，實際 ${res.secondTab.total}`);
  if (res.before0845.total !== round) fail.push('08:45 前不應再查');
  if (res.after0845.total !== round * 2) fail.push(`08:45 應再查 1 輪，實際 ${res.after0845.total}`);
  if (res.before1345.total !== round * 2) fail.push(`08:45–13:45 之間不應查，實際 ${res.before1345.total}`);
  if (res.after1345.total !== round * 3) fail.push(`13:45 應再查 1 輪，實際 ${res.after1345.total}`);
  if (res.after1445.total !== round * 4) fail.push(`14:45 應再查 1 輪，實際 ${res.after1445.total}`);
  for (const k of ['startup', 'after1445']) if (res[k].blocked) fail.push(`有程式在非時段查期權帳務（被閘門擋下 ${res[k].blocked} 次）`);
  console.log(fail.length ? '✖ FAIL\n  ' + fail.join('\n  ') : '✓ PASS');
  if (fail.length) process.exitCode = 1;
  await b.close();
})();
