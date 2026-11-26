// 商品頁（需求：docs/ai/requirements.md 第 8 輪）
//   左：商品報價小卡（個股＋期貨）。固定頁籤「庫存」「期貨（微台近月／次月）」＋自訂頁籤（與自選群組共用、電腦手機同步）
//   右：選擇權 T 字報價（小卡選結算日）
//   點小卡 → openTA()（之後換成技術分析窗口）
import { account } from '../core/account';
import { hub, keyOf } from '../core/hub';
import { openTA } from '../core/nav';
import { store } from '../core/store';
import { cls, esc, fin, fmt, fmtP, isLive, LS, sign, pointerHeld } from '../core/util';
import { TChain } from '../ui/tchain';
import type { Contract } from '../types';
import type { Page } from './page';

const OWNER = 'products';
const FIXED = [{ id: 'hold', name: '庫存報價' }, { id: 'fut', name: '近月＆次月期貨' }];

const TEMPLATE = `
<section class="pd">
  <div class="card pd-left">
    <div class="pd-tabs" id="pd-tabs"></div>
    <div class="pd-tools" id="pd-tools"></div>
    <div class="pd-grid" id="pd-grid"></div>
  </div>
  <div class="card pd-right"><div class="ct">選擇權 T 字報價<span class="ct-r muted">臺指選擇權</span></div><div id="pd-chain"></div></div>
</section>`;

interface Item { c: Contract; name: string; held?: { qty: number; pnl: number }; removable?: boolean }

let mounted = false;
let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const cleanups: (() => void)[] = [];
let tab = LS.get('pdTab') ?? 'hold';
let items: Item[] = [];
let chain: TChain | null = null;
let futList: (Contract & { name?: string; delivery_month?: string })[] = [];
const contracts = new Map<string, Contract>();

async function stk(code: string): Promise<Contract> {
  const hit = contracts.get(code);
  if (hit) return hit;
  const c = await hub.be.resolve(code, 'STK').catch(() => ({ security_type: 'STK', exchange: 'TSE', code } as Contract));
  contracts.set(code, c);
  return c;
}

/** 微台近月＋次月（結算後自動換月，pitfalls #1） */
async function loadFutures() {
  const list = (await hub.be.futuresList('TMF').catch(() => [])).filter((f) => isLive(f.delivery_date))
    .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date)).slice(0, 2);
  futList = list;
}

/** 依目前頁籤組出商品清單，並調整訂閱（只訂閱看得到的頁籤） */
async function buildItems() {
  let next: Item[] = [];
  if (tab === 'hold') {
    const byCode = new Map<string, { qty: number; pnl: number }>();
    for (const p of account.state.stkPos) {
      const h = byCode.get(p.code) ?? { qty: 0, pnl: 0 };
      h.qty += p.quantity; h.pnl += account.stockPnl(p);
      byCode.set(p.code, h);
    }
    next = await Promise.all([...byCode].map(async ([code, held]) => ({ c: await stk(code), name: account.nameOf(code), held })));
  } else if (tab === 'fut') {
    if (!futList.length) await loadFutures();
    next = futList.map((f, i) => ({ c: f, name: `微台 ${Number((f.delivery_month ?? '').slice(4, 6)) || ''}月${i === 0 ? '（近月）' : '（次月）'}` }));
  } else {
    const g = store.data.groups.find((x) => x.id === tab);
    next = await Promise.all((g?.codes ?? []).map(async (code) => ({ c: await stk(code), name: account.nameOf(code), removable: true })));
  }
  if (!mounted) return;
  const want = new Set(next.map((i) => keyOf(i.c)));
  for (const it of items) if (!want.has(keyOf(it.c))) hub.release(OWNER, it.c, ['Tick', 'BidAsk']);
  const fresh = next.filter((i) => !items.some((o) => keyOf(o.c) === keyOf(i.c)));
  for (const it of next) hub.acquire(OWNER, it.c, ['Tick', 'BidAsk']);
  items = next;
  if (fresh.length) hub.loadSnapshots(fresh.map((i) => i.c));
  dirty = true;
}

function renderTabs() {
  const groups = store.data.groups;
  if (!FIXED.some((f) => f.id === tab) && !groups.some((g) => g.id === tab)) tab = 'hold';
  document.getElementById('pd-tabs')!.innerHTML =
    FIXED.map((f) => `<button class="pd-tab fixed${tab === f.id ? ' on' : ''}" data-tab="${f.id}">${f.name}</button>`).join('') +
    '<span class="pd-sep"></span>' +
    groups.map((g) => `<button class="pd-tab${tab === g.id ? ' on' : ''}" data-tab="${g.id}" draggable="true">${esc(g.name)}<small>${g.codes.length}</small></button>`).join('') +
    '<button class="pd-tab add" data-act="add" title="新增自訂頁籤">＋</button>';
  const custom = groups.find((g) => g.id === tab);
  document.getElementById('pd-tools')!.innerHTML = custom
    ? `<input id="pd-add" placeholder="輸入股票代碼加入「${esc(custom.name)}」，Enter" autocomplete="off">
       <button data-act="ren">改名</button><button data-act="del">刪除頁籤</button>
       <span class="muted">${store.synced ? '✓ 電腦手機同步' : '只存在這個瀏覽器'}・拖曳小卡可排序</span>`
    : tab === 'fut' ? '<span class="muted">微台指期貨近月與次月，結算後自動換月；轉倉價差＝次月 − 近月</span>'
      : `<span class="muted">${account.state.ready && !account.state.sAccount ? 'API Key 尚未綁定證券帳戶' : '證券庫存自動帶入'}</span>`;
}

function card(it: Item) {
  const k = keyOf(it.c);
  const x = hub.quotes.get(k);
  const last = x?.last ?? NaN, ref = x?.ref ?? NaN, ch = last - ref, pct = (ch / ref) * 100;
  const bid = x?.bids[0]?.[0] ?? x?.snapBid ?? NaN, ask = x?.asks[0]?.[0] ?? x?.snapAsk ?? NaN;
  const bidV = x?.bids[0]?.[1], askV = x?.asks[0]?.[1];
  const ratio = fin(x?.volRatio ?? NaN) ? x!.volRatio : fin(x?.yVol ?? NaN) && x!.yVol > 0 ? x!.vol / x!.yVol : NaN;
  const fl = x && performance.now() - x.flash < 700 ? (x.dir > 0 ? ' fu' : ' fd') : '';
  const isFut = it.c.security_type === 'FUT';
  const unit = isFut ? '口' : '張';
  const tint = !fin(pct) ? '' : pct > 0 ? 'tint-up' : pct < 0 ? 'tint-dn' : '';
  return `<div class="qc ${tint}" data-key="${esc(k)}" ${it.removable ? 'draggable="true"' : ''}>
    <div class="qc-h"><b>${esc(it.c.security_type === 'STK' ? account.nameOf(it.c.code) : it.name)}</b><small>${esc(it.c.code)}</small>
      ${it.removable ? `<button class="qc-x" data-rm="${esc(it.c.code)}" title="移除">×</button>` : ''}</div>
    <div class="qc-p ${cls(ch)}${fl}">${fmtP(last)}</div>
    <div class="qc-c ${cls(ch)}">${sign(ch, last < 100 ? 2 : isFut ? 0 : 1)}　${fin(pct) ? sign(pct, 2) + '%' : ''}</div>
    <div class="qc-row"><span>量</span><b>${x && x.vol ? fmt(x.vol) : '—'}<small> ${unit}</small></b>
      <span>量比</span><b class="${fin(ratio) && ratio >= 1.5 ? 'accent' : ''}">${fin(ratio) ? ratio.toFixed(2) : '—'}</b></div>
    <div class="qc-ba"><span class="b">買 <b>${fmtP(bid)}</b>${bidV ? `<small>${bidV}</small>` : ''}</span>
      <span class="a">賣 <b>${fmtP(ask)}</b>${askV ? `<small>${askV}</small>` : ''}</span></div>
    ${it.held ? `<div class="qc-held">庫存 ${it.held.qty} ${unit}　<b class="${cls(it.held.pnl)}">${sign(it.held.pnl, 0)}</b></div>` : ''}
  </div>`;
}

function renderGrid() {
  const grid = document.getElementById('pd-grid')!;
  if (!items.length) {
    grid.innerHTML = `<div class="muted pd-empty">${tab === 'hold' ? (account.state.ready ? '目前沒有庫存' : '查詢庫存中…')
      : tab === 'fut' ? '載入期貨合約中…' : '這個頁籤還沒有股票，用上方輸入框加入'}</div>`;
    return;
  }
  let extra = '';
  if (tab === 'fut' && items.length === 2) {
    const a = hub.quotes.get(keyOf(items[0].c))?.last ?? NaN, b = hub.quotes.get(keyOf(items[1].c))?.last ?? NaN;
    const sp = b - a;
    extra = `<div class="qc spread"><div class="qc-h"><b>轉倉價差</b><small>次月 − 近月</small></div>
      <div class="qc-p ${cls(sp)}">${fin(sp) ? sign(sp, 0) : '—'}</div>
      <div class="qc-c muted">${fin(sp) ? (sp >= 0 ? '正價差：次月較貴' : '逆價差：次月較便宜') : ''}</div></div>`;
  }
  grid.innerHTML = items.map(card).join('') + extra;
}

function frame() {
  if (!mounted) return;
  if (dirty && !pointerHeld()) { dirty = false; renderGrid(); }
  for (const it of items) { const x = hub.quotes.get(keyOf(it.c)); if (x && performance.now() - x.flash < 800) { dirty = true; break; } }
  timer = setTimeout(() => requestAnimationFrame(frame), 250);
}

function setTab(id: string) {
  tab = id; LS.set('pdTab', id);
  renderTabs();
  items.forEach((it) => hub.release(OWNER, it.c, ['Tick', 'BidAsk']));
  items = [];
  dirty = true;
  buildItems();
}

function bind(el: HTMLElement) {
  el.querySelector('#pd-tabs')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.act === 'add') {
      const name = prompt('新頁籤名稱', '')?.trim();
      if (!name) return;
      const id = 'g' + Date.now();
      store.update((d) => d.groups.push({ id, name, codes: [] }));
      setTab(id);
      return;
    }
    if (b.dataset.tab && b.dataset.tab !== tab) setTab(b.dataset.tab);
  });
  // 自訂頁籤拖曳排序
  let dragTab = '';
  const tabs = el.querySelector('#pd-tabs')!;
  tabs.addEventListener('dragstart', (ev) => { dragTab = (ev.target as HTMLElement).dataset.tab ?? ''; });
  tabs.addEventListener('dragover', (ev) => ev.preventDefault());
  tabs.addEventListener('drop', (ev) => {
    const over = (ev.target as HTMLElement).closest<HTMLElement>('[draggable][data-tab]')?.dataset.tab;
    if (!dragTab || !over || dragTab === over) return;
    store.update((d) => {
      const g = d.groups.find((x) => x.id === dragTab)!;
      const rest = d.groups.filter((x) => x.id !== dragTab);
      rest.splice(rest.findIndex((x) => x.id === over), 0, g);
      d.groups = rest;
    });
  });
  el.querySelector('#pd-tools')!.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).dataset.act;
    const g = store.data.groups.find((x) => x.id === tab);
    if (!g) return;
    if (act === 'ren') { const n = prompt('頁籤新名稱', g.name)?.trim(); if (n) store.update(() => { g.name = n; }); }
    if (act === 'del') {
      if (store.data.groups.length <= 1) { alert('至少要保留一個自訂頁籤'); return; }
      if (confirm(`刪除頁籤「${g.name}」（${g.codes.length} 檔）？`)) { store.update((d) => { d.groups = d.groups.filter((x) => x.id !== g.id); }); setTab('hold'); }
    }
  });
  el.querySelector('#pd-tools')!.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    const input = e.target as HTMLInputElement;
    if (e.key !== 'Enter' || input.id !== 'pd-add') return;
    const code = input.value.trim().toUpperCase();
    const g = store.data.groups.find((x) => x.id === tab);
    if (!code || !g) return;
    input.value = '';
    if (!g.codes.includes(code)) store.update(() => { g.codes.push(code); });
  });
  const grid = el.querySelector('#pd-grid')!;
  grid.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const rm = t.closest<HTMLElement>('[data-rm]')?.dataset.rm;
    if (rm) {
      ev.stopPropagation();
      store.update(() => { const g = store.data.groups.find((x) => x.id === tab); if (g) g.codes = g.codes.filter((c) => c !== rm); });
      return;
    }
    const key = t.closest<HTMLElement>('.qc[data-key]')?.dataset.key;
    const it = items.find((i) => keyOf(i.c) === key);
    if (it) openTA(it.c);
  });
  // 自訂頁籤內拖曳小卡排序
  let dragCard = '';
  grid.addEventListener('dragstart', (ev) => { dragCard = (ev.target as HTMLElement).closest<HTMLElement>('.qc')?.dataset.key ?? ''; });
  grid.addEventListener('dragover', (ev) => ev.preventDefault());
  grid.addEventListener('drop', (ev) => {
    const over = (ev.target as HTMLElement).closest<HTMLElement>('.qc[draggable]')?.dataset.key;
    const g = store.data.groups.find((x) => x.id === tab);
    if (!g || !dragCard || !over || dragCard === over) return;
    store.update(() => {
      const arr = g.codes.filter((c) => c !== dragCard);
      arr.splice(arr.indexOf(over), 0, dragCard);
      g.codes = arr;
    });
  });
}

export const productsPage: Page = {
  id: 'products',
  title: '商品',
  mount(el) {
    mounted = true;
    dirty = true;
    el.innerHTML = TEMPLATE;
    bind(el);
    account.use(OWNER);
    renderTabs();
    chain = new TChain(document.getElementById('pd-chain')!);
    cleanups.push(hub.on('change', () => { dirty = true; }));
    cleanups.push(account.on(() => { if (tab === 'hold') buildItems(); else dirty = true; renderTabs(); }));
    cleanups.push(store.on(() => { renderTabs(); if (tab !== 'hold' && tab !== 'fut') buildItems(); }));
    // 期貨換月：每分鐘重抓微台近月／次月
    const t = setInterval(async () => {
      const before = futList.map((f) => f.code).join();
      await loadFutures();
      if (tab === 'fut' && futList.map((f) => f.code).join() !== before) setTab('fut');
    }, 60_000);
    cleanups.push(() => clearInterval(t));
    store.load();
    buildItems();
    frame();
  },
  unmount() {
    mounted = false;
    clearTimeout(timer);
    cleanups.splice(0).forEach((f) => f());
    chain?.destroy(); chain = null;
    hub.releaseAll(OWNER);
    account.unuse(OWNER);
    items = [];
  },
};
