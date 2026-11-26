// 版面回歸測試（需先 npx vite --port 5173；用系統的 Playwright）：node tests/ui/layout.cjs [截圖資料夾]
// 檢查：個股盤中三欄上下切齊、1920×912（使用者瀏覽器可視範圍）不需捲動；總覽熱力圖在畫面內
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  // 912：使用者 1920×1080 螢幕扣掉 Chrome 分頁列/網址列/書籤列與工作列後的可視高度
  for (const [w, h] of [[1920, 912], [1920, 1080], [1600, 860], [1440, 800]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    p.on('pageerror', e => errs.push(e.message));
    await p.clock.install({ time: new Date('2026-11-26T03:30:00Z') }); await p.clock.resume();
    await p.goto('http://localhost:5173/?demo=1#/stocks/2330');
    await p.evaluate(() => localStorage.setItem('mw.stkMode', 'live'));
    await p.reload(); await p.waitForTimeout(6000);
    const r = await p.evaluate(() => {
      const box = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
      const fc = document.querySelector('.flowchart').getBoundingClientRect();
      const side = document.querySelector('.lv-side');
      const tiers = [...document.querySelectorAll('.bigt tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 40));
      return { needScroll: document.scrollingElement.scrollHeight > innerHeight + 1, pageH: document.scrollingElement.scrollHeight,
        chart: box('.lv-chart'), side: box('.lv-side .card:last-child'), ticks: box('.lv-ticks'), flowChartH: Math.round(fc.height),
        sideOverflow: side.scrollHeight > side.clientHeight + 1, tiers };
    });
    console.log(w + 'x' + h, JSON.stringify(r));
    await p.screenshot({ path: `${out}/fit-${w}x${h}.png` });
    await p.close();
  }
  // 總覽：熱力圖要在畫面內、整頁不需捲動（2026-11-26 曾因 .live class 撞名把熱力圖推出畫面，pitfalls #16）
  const p = await b.newPage({ viewport: { width: 1920, height: 912 } });
  p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-11-26T03:30:00Z') }); await p.clock.resume();
  await p.goto('http://localhost:5173/?demo=1#/overview'); await p.waitForTimeout(6000);
  const ov = await p.evaluate(() => {
    const h = document.querySelector('.heat').getBoundingClientRect();
    return { heatTop: Math.round(h.top), heatBottom: Math.round(h.bottom), pageH: document.scrollingElement.scrollHeight };
  });
  console.log('overview 1920x912', JSON.stringify(ov), ov.heatBottom <= 912 ? 'OK' : '❌ 熱力圖超出畫面');
  await p.screenshot({ path: `${out}/overview-1920x912.png` });
  console.log(errs);
  await b.close();
})();
