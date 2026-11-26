// App 外框：頁籤路由、全域報價列（加權／台指期）、連線狀態、時鐘
import './style.css';
import { installOrderGuard } from './core/guard';
// 下單絕對防堵：最先執行，之後任何程式碼都無法連到下單路徑（core/guard.ts）
installOrderGuard();
// 緊急重設：網址加 ?reset=1 → 清掉分析頁／下單頁記住的商品與模式、K 棒快取，回到總覽（頁面卡死時的逃生口，pitfalls #25）
if (new URLSearchParams(location.search).has('reset')) {
  for (const k of ['stkMode', 'stkUnit', 'stkCode', 'tdCode', 'page', 'taCfg']) localStorage.removeItem('mw.' + k);
  try { indexedDB.deleteDatabase('mw-bars'); } catch { /* 略過 */ }
  history.replaceState(null, '', location.pathname + '#/overview');
}
import { initDiag } from './core/diag';
import { hub } from './core/hub';
import { $, cls, fin, fmt, LS, retry, session, sign } from './core/util';
import { accountPage } from './pages/account';
import { optionsPage } from './pages/options';
import { overviewPage } from './pages/overview';
import type { Page } from './pages/page';
import { productsPage } from './pages/products';
import { stocksPage } from './pages/stocks';
import { tradePage } from './pages/trade';

const PAGES: Page[] = [overviewPage, productsPage, stocksPage, optionsPage, tradePage, accountPage];
let current: Page | null = null;

function route() {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0] || LS.get('page') || 'overview';
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0];
  if (page === current) return;
  // 舊頁面卸載出錯也要能切換頁籤，不然整個 App 會卡在同一頁
  try { current?.unmount(); } catch (e) { console.error('unmount', current?.id, e); }
  current = page;
  LS.set('page', page.id);
  document.querySelectorAll<HTMLElement>('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.id === page.id));
  document.title = `${page.title}・看盤`;
  const el = $('page');
  el.innerHTML = '';
  el.className = 'page page-' + page.id;
  window.scrollTo(0, 0);
  Promise.resolve(page.mount(el)).catch((e) => console.error(page.id, e));
}

// ── 全域報價列：每一頁都看得到加權指數與台指期 ──
let tickerDirty = true;
function renderTicker() {
  if (!tickerDirty) return;
  tickerDirty = false;
  const i = hub.idx;
  const f = hub.quotes.get(hub.futKey);
  const item = (name: string, last: number, ref: number, d = 0) => {
    const ch = last - ref;
    return `<span class="tk"><em>${name}</em><b class="${cls(ch)}">${fmt(last, d)}</b>
      <small class="${cls(ch)}">${sign(ch, d)} ${fin(ref) && ref ? sign((ch / ref) * 100, 2) + '%' : ''}</small></span>`;
  };
  $('ticker').innerHTML = (i ? item('加權', i.close, i.reference, 2) : '') +
    (f ? item(hub.futName.replace('台指期 ', '台指'), f.last, f.ref) : '');
}

function clock() {
  const t = new Date(Date.now() + 8 * 3600_000);
  $('clock').textContent = t.toISOString().slice(11, 19);
  const s = session();
  $('session').textContent = s === 'day' ? '日盤' : s === 'night' ? '夜盤' : '休市';
  $('session').className = 'session' + (s !== 'closed' ? ' open' : '');
  renderTicker();
}

async function boot() {
  $('tabs').innerHTML = PAGES.map((p) => `<a href="#/${p.id}" data-id="${p.id}">${p.title}</a>`).join('');
  hub.on('status', (s) => {
    const el = $('conn');
    el.className = 'conn ' + s;
    el.textContent = { connecting: '連線中…', live: '即時', down: '斷線・重連中', demo: 'DEMO' }[s];
  });
  hub.on('change', () => { tickerDirty = true; });
  setInterval(clock, 1000);
  setInterval(renderTicker, 300);
  clock();

  const { fellBackToDemo } = await hub.init();
  $('banner').hidden = !fellBackToDemo;
  const envEl = $('env');
  envEl.textContent = { sim: '模擬環境', prod: '正式環境', demo: 'DEMO 假資料' }[hub.env];
  envEl.className = 'env ' + hub.env;

  // 台指期近月（所有頁面共用；結算後自動換月）
  await hub.setFuture(await retry('查詢台指期商品檔', () => hub.pickFuture(), (html) => {
    $('page').innerHTML = `<div class="boot-msg">${html}</div>`;
  }));
  setInterval(() => hub.rollFuture(), 60_000);

  window.addEventListener('hashchange', route);
  route();
}

initDiag();
boot().catch((e) => {
  console.error(e);
  $('page').innerHTML = `<div class="boot-msg">啟動失敗：${String(e?.message ?? e)}</div>`;
});
