// 下單頁（模擬）：閃電下單（價位階梯＝單一個股的 T 字報價）＋庫存狀況＋損益試算＋走勢／大單／分價／逐筆
//
// ⚠ 目前只做「模擬委託」（core/simorder.ts），程式內沒有任何送單功能；所有對外連線另有防堵（core/guard.ts）。
//
//   上：個股資訊｜庫存狀況（成交均價、持有股數、當沖損益兩平價、未實現損益）｜損益試算（買賣五檔平倉損益）
//   左：條件（現股／現股當沖／零股）、數量、ROD/IOC → 手動下單（輸入價格／數量／ROD・IOC／送出）、市價買進／賣出（數量＝閃電設定）
//       → 價位階梯（雙擊左半買進、右半賣出；單擊價格＝帶入手動價格；點自己的委託數量＝刪單）→ 委託回報
//   右：盤中走勢（09:00–13:30）｜大單統計＋累計淨買｜分價明細｜逐筆成交
import {
  ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { account } from '../core/account';
import { catalog } from '../core/catalog';
import { TIER, TIER_COLOR, tierOf } from '../core/flow';
import { hub } from '../core/hub';
import { dayStart, dstr } from '../core/session';
import {
  COND_NAME, type Cond, position, simBook, snap, stepDown, stepUp, type Side, type Tif,
} from '../core/simorder';
import { cls, cssVar, esc, fin, fmt, fmtP, LS, pointerHeld, sign, tpeToday } from '../core/util';
import type { Bar, Contract, Info, Tick } from '../types';
import type { Page } from './page';

const OWNER = 'trade';

const TEMPLATE = `
<section class="td">
  <div class="td-top">
    <div class="card td-info">
      <div class="td-search"><input id="td-q" placeholder="代碼或名稱，Enter 開啟" autocomplete="off"><div id="td-sug" class="td-sug" hidden></div></div>
      <div id="td-head" class="td-head"></div>
    </div>
    <div class="card td-pos"><div class="ct">庫存狀況<span class="tip" title="實際庫存（帳務）＋今天的模擬成交。損益已扣手續費（2.2 折估算）與證交稅（當沖 0.15%、現股 0.3%）">?</span></div><div id="td-pos"></div></div>
    <div class="card td-calc"><div class="ct">損益試算<span id="td-calc-t" class="ct-r muted"></span></div><div id="td-calc"></div></div>
  </div>
  <div class="td-main">
    <div class="card td-lcard">
      <div class="td-sim">模擬下單：不會送出任何委託（下單功能已封鎖）</div>
      <div class="td-ctl">
        <div class="seg" id="td-cond"><button data-c="cash">現股</button><button data-c="dt">現股當沖</button><button data-c="odd">零股</button></div>
        <label class="td-qty"><input id="td-n" type="number" min="1" value="1"><span id="td-unit">張</span></label>
        <div class="seg" id="td-tif"><button data-t="ROD">ROD</button><button data-t="IOC">IOC</button></div>
      </div>
      <div class="td-ctl2"><span class="muted">數量</span><span id="td-quick"></span>
        <button id="td-center" title="回到成交價">⊙ 置中</button><button id="td-cxl" title="刪除這檔全部掛單">全部刪單</button></div>
      <div class="td-man">
        <label class="td-mf">價格<input id="td-mp" type="number" step="any" placeholder="點階梯價格帶入"></label>
        <label class="td-mf"><input id="td-mq" type="number" min="1" value="1"><span class="td-munit">張</span></label>
        <select id="td-mtif" title="委託條件"><option value="ROD">ROD</option><option value="IOC">IOC</option></select>
        <button class="td-mb" data-m="B">買進送出</button><button class="td-ms" data-m="S">賣出送出</button>
      </div>
      <div class="td-mkt"><button class="td-mb" data-k="B">市價買進 <small class="td-mkq"></small></button><button class="td-ms" data-k="S">市價賣出 <small class="td-mkq"></small></button></div>
      <div class="td-lh"><span>委買</span><span>買進量</span><span>價格</span><span>賣出量</span><span>委賣</span></div>
      <div id="td-ladder" class="td-ladder"></div>
      <div id="td-msg" class="td-msg">雙擊左半＝買進、右半＝賣出；單擊價格＝帶入手動價格；點自己的委託數量＝刪單</div>
      <div class="td-oh"><b>委託回報</b><span class="muted">（模擬）</span><button id="td-clear" class="td-clear" title="清除今天全部模擬紀錄">清除</button></div>
      <div id="td-orders" class="td-orders"></div>
    </div>
    <div class="td-right">
      <div class="card td-chart"><div class="td-ich"><div id="td-ichart" class="fc-in"></div></div>
        <div class="lgd"><i class="l-px"></i>成交價　<i class="l-vwap"></i>VWAP 均價　<span class="dash">- - </span>參考價</div></div>
      <div class="td-r2">
        <div class="card td-flow"><div class="ct">大單統計<span class="tip" title="依單筆成交金額與張數推估（與分析頁相同）；淨買＝外盤（主動買）−內盤（主動賣）">?</span></div>
          <div id="td-big"></div><div class="flow-head"><span>累計淨買</span><span id="td-flgd" class="flow-lgd"></span></div>
          <div class="td-fch"><div id="td-fchart" class="fc-in"></div></div></div>
        <div class="card td-vp"><div class="ct">分價明細<span class="ct-r muted">量｜外盤比</span></div><div id="td-vp" class="td-vplist"></div></div>
        <div class="card td-ticks"><div class="ct">逐筆成交</div><div id="td-ticks" class="td-tlist"></div></div>
      </div>
    </div>
  </div>
</section>`;

// ───────── 狀態 ─────────
let mounted = false;
let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const cleanups: (() => void)[] = [];
let code = '';
let contract: Contract | null = null;
let info: Info | null = null;
let ticks: Tick[] = [];
let seq = 0;
let cond: Cond = (LS.get('tdCond') as Cond) ?? 'cash';
let tif: Tif = (LS.get('tdTif') as Tif) ?? 'ROD';
let center = NaN;            // 階梯中心價
let follow = true;           // 成交價跑出畫面時自動置中
let lastClick = { at: 0, key: '' };
let holdRender = 0;          // 點擊後短暫暫停重繪，避免雙擊被重畫打斷（pitfalls #12）

const etf = () => code.startsWith('00');
const q = () => hub.quotes.get(code);
const nameOf = (c: string) => catalog.get(c)?.name ?? account.nameOf(c);

// ───────── 開啟個股 ─────────
async function open(c: string) {
  c = c.trim().toUpperCase();
  if (!c || c === code) return;
  if (contract) hub.release(OWNER, contract, ['Tick', 'BidAsk']);
  code = c; LS.set('tdCode', c);
  if (location.hash !== `#/trade/${c}`) history.replaceState(null, '', `#/trade/${c}`);
  const my = ++seq;
  contract = null; info = null; ticks = []; center = NaN; follow = true;
  dirty = true;
  const ct: Contract = await hub.be.resolve(c, 'STK').catch(() => catalog.contract(c));
  if (my !== seq || !mounted) return;
  contract = ct;
  hub.acquire(OWNER, ct, ['Tick', 'BidAsk']);
  hub.loadSnapshots([ct]);
  hub.be.contractInfo(ct).then((i) => { if (my === seq) { info = i; dirty = true; } }).catch(() => undefined);
  const bars = await hub.be.kbars(ct, tpeToday(-7), tpeToday()).catch(() => [] as Bar[]);
  if (my !== seq || !mounted) return;
  const day = setIntraday(bars);
  hub.be.ticksDay(ct, day).then((t) => { if (my === seq) { ticks = t; flowLen = -1; dirty = true; } }).catch(() => undefined);
}

// ───────── 庫存與部位 ─────────
function realHolding() {
  const ps = account.state.stkPos.filter((p) => p.code === code && p.direction !== 'Sell');
  const qty = ps.reduce((s, p) => s + p.quantity * 1000, 0);
  const avg = qty ? ps.reduce((s, p) => s + p.price * p.quantity * 1000, 0) / qty : 0;
  // 昨日庫存（yd_quantity）以前買的用一般稅率；今天新買的部分平倉可享當沖減稅（沒有這個欄位時視為昨日庫存）
  const yd = ps.reduce((s, p) => s + Math.min(p.quantity, p.yd_quantity ?? p.quantity) * 1000, 0);
  return { qty, avg, yd, today: qty - yd };
}
const curPos = () => position(realHolding(), code);

/**
 * 實際庫存以價格 P 全部賣出的淨損益（使用者指定的計算原則，手續費依原價、逐項捨去）：
 *   損益 ＝（賣出總額 − 賣出手續費 − 證交稅）−（庫存成本 ＋ 買進手續費）
 *   庫存成本＝成交均價 × 股數；手續費＝金額 × 0.1425% 捨去；證交稅：今天買的 0.15%（當沖減稅）、昨日庫存 0.3%
 */
const FULL = 0.001425;
function holdPnl(h: ReturnType<typeof realHolding>, P: number) {
  const cost = Math.floor(h.avg * h.qty), buyFee = Math.floor(cost * FULL);
  const sell = Math.floor(P * h.qty), sellFee = Math.floor(sell * FULL);
  const tax = Math.floor(P * h.today * 0.0015) + Math.floor(P * h.yd * 0.003);
  return sell - sellFee - tax - (cost + buyFee);
}
/** 損益兩平價（同上公式）：精確值與可掛的價位（往上取到升降單位） */
function holdBreakEven(h: ReturnType<typeof realHolding>) {
  if (!h.qty) return { exact: NaN, tick: NaN };
  const taxR = (h.today * 0.0015 + h.yd * 0.003) / h.qty;
  const exact = (h.avg * (1 + FULL)) / (1 - FULL - taxR);
  let p = snap(exact, etf());
  if (p < exact - 1e-9) p = stepUp(p, etf());
  for (let i = 0; i < 50 && holdPnl(h, p) < 0; i++) p = stepUp(p, etf());  // 捨去造成的差額再往上找
  return { exact, tick: p };
}

// ───────── 上方：個股資訊、庫存、損益試算 ─────────
function renderHead() {
  const x = q();
  const ref = fin(x?.ref ?? NaN) ? x!.ref : info?.reference ?? NaN;
  const last = x?.last ?? NaN, ch = last - ref;
  const chip = (k: string, v: string, c = '') => `<span class="chip2"><em>${k}</em><b class="${c}">${v}</b></span>`;
  document.getElementById('td-head')!.innerHTML = `<div class="td-name"><b>${esc(info?.name ?? nameOf(code))}</b> <small>${code}</small></div>
    <div class="td-px ${cls(ch)}">${fmtP(last)}<small>${sign(ch, last < 100 ? 2 : 1)}　${fin(ch) && ref ? sign((ch / ref) * 100, 2) + '%' : ''}</small></div>
    <div class="td-chips">${chip('開', fmtP(x?.open ?? NaN), cls((x?.open ?? NaN) - ref))}${chip('高', fmtP(x?.high ?? NaN), 'up')}${chip('低', fmtP(x?.low ?? NaN), 'down')}
      ${chip('參考', fmtP(ref))}${chip('漲停', fmtP(info?.limit_up ?? NaN), 'up')}${chip('跌停', fmtP(info?.limit_down ?? NaN), 'down')}${chip('總量', x ? fmt(x.vol) + ' 張' : '—')}</div>`;
}

/** 庫存狀況：只用實際庫存（帳務）；模擬成交另列一行，不混入 */
function renderPos() {
  const h = realHolding();
  const last = q()?.last ?? NaN;
  const unreal = h.qty && fin(last) ? holdPnl(h, last) : NaN;
  const be = holdBreakEven(h);
  const sim = curPos();
  const simQty = sim.qty - h.qty;
  const kv = (k: string, v: string, c = '', sub = '') => `<div><span>${k}</span><b class="${c}">${v}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
  document.getElementById('td-pos')!.innerHTML = `<div class="td-kv">
    ${kv('成交均價', h.qty ? fmtP(h.avg) : '—')}
    ${kv('持有股數', fmt(h.qty), '', h.qty ? `${fmt(h.qty / 1000, 3).replace(/\.?0+$/, '')} 張${h.today ? `・今日買 ${fmt(h.today)} 股` : ''}` : '目前沒有庫存')}
    ${kv('當沖損益兩平價', fin(be.tick) ? fmtP(be.tick) : '—', 'accent', fin(be.exact) ? `精確 ${be.exact.toFixed(2)}・賣在此價以上不賠` : '')}
    ${kv('未實現損益', fin(unreal) ? sign(unreal, 0) : '—', cls(unreal), '扣原價手續費與證交稅')}
    ${kv('模擬（今日）', sim.traded ? sign(sim.realized, 0) : '—', cls(sim.realized), sim.traded ? `模擬部位 ${simQty >= 0 ? '' : '空 '}${fmt(Math.abs(simQty))} 股` : '沒有模擬成交')}
  </div>`;
}

/** 損益試算：實際庫存在成交價上下五檔（依升降單位）全部賣出的淨損益，公式見 holdPnl() */
function renderCalc() {
  const h = realHolding();
  const last = q()?.last ?? NaN;
  const el = document.getElementById('td-calc')!;
  const t = document.getElementById('td-calc-t')!;
  if (!h.qty) { t.textContent = ''; el.innerHTML = '<div class="muted">目前沒有這檔的庫存，無法試算</div>'; return; }
  t.textContent = `庫存 ${fmt(h.qty)} 股・均價 ${fmtP(h.avg)}・手續費原價 0.1425%・稅 ${h.today ? (h.yd ? '當沖 0.15%＋現股 0.3%' : '當沖 0.15%') : '0.3%'}`;
  if (!fin(last)) { el.innerHTML = '<div class="muted">等待成交價…</div>'; return; }
  const c = snap(last, etf());
  const up: number[] = [], dn: number[] = [];
  let p = c; for (let i = 0; i < 5; i++) { p = stepUp(p, etf()); up.unshift(p); }
  p = c; for (let i = 0; i < 5; i++) { p = stepDown(p, etf()); dn.push(p); }
  const lu = info?.limit_up ?? Infinity, ld = info?.limit_down ?? 0;
  const levels: [string, number][] = [...up.map((v, i): [string, number] => [`上${5 - i}`, v]), ['成交', c] as [string, number], ...dn.map((v, i): [string, number] => [`下${i + 1}`, v])]
    .filter(([, v]) => v <= lu + 1e-6 && v >= ld - 1e-6);
  el.innerHTML = `<table class="grid td-ct"><tr><th></th>${levels.map(([k]) => `<th class="${k === '成交' ? 'accent' : k[0] === '上' ? 'up' : 'down'}">${k}</th>`).join('')}</tr>
    <tr><td class="muted">價格</td>${levels.map(([k, v]) => `<td class="${k === '成交' ? 'b' : ''}">${fmtP(v)}</td>`).join('')}</tr>
    <tr><td class="muted">損益</td>${levels.map(([, v]) => { const r = holdPnl(h, v); return `<td class="b ${cls(r)}">${sign(r, 0)}</td>`; }).join('')}</tr></table>`;
}

// ───────── 閃電下單：價位階梯 ─────────
const qtyShares = () => {
  const n = Math.max(1, Math.round(Number((document.getElementById('td-n') as HTMLInputElement | null)?.value) || 1));
  return cond === 'odd' ? n : n * 1000;
};

function ladderPrices(): number[] {
  const el = document.getElementById('td-ladder')!;
  const rows = Math.max(9, Math.floor((el.clientHeight || 500) / 20));
  const last = q()?.last ?? info?.reference ?? NaN;
  if (!fin(last)) return [];
  if (!fin(center) || (follow && (last > center + tickRange(rows / 2 - 2) || last < center - tickRange(rows / 2 - 2)))) center = snap(last, etf());
  const half = Math.floor(rows / 2);
  const out: number[] = [];
  let p = center;
  for (let i = 0; i < half; i++) p = stepUp(p, etf());
  for (let i = 0; i < rows; i++) { out.push(p); p = stepDown(p, etf()); }
  const up = info?.limit_up ?? Infinity, dn = info?.limit_down ?? 0;
  return out.filter((x) => x <= up + 1e-6 && x >= dn - 1e-6 && x > 0);
}
function tickRange(n: number) { let p = center; for (let i = 0; i < n; i++) p = stepUp(p, etf()); return p - center; }

function renderLadder() {
  const x = q();
  const bids = new Map((x?.bids ?? []).map(([p, v]) => [p, v]));
  const asks = new Map((x?.asks ?? []).map(([p, v]) => [p, v]));
  const mx = Math.max(1, ...[...bids.values(), ...asks.values()]);
  const mine = simBook.working(code);
  const myAt = (p: number, s: Side) => mine.filter((o) => o.side === s && Math.abs(o.price - p) < 1e-6);
  const last = x?.last ?? NaN, ref = x?.ref ?? info?.reference ?? NaN;
  const p0 = realHolding();                           // 均價、兩平價標記只看實際庫存
  const be = holdBreakEven(p0).tick;
  const unit = cond === 'odd' ? 1 : 1000;
  document.getElementById('td-ladder')!.innerHTML = ladderPrices().map((p) => {
    const b = bids.get(p), a = asks.get(p);
    const mb = myAt(p, 'B'), ms = myAt(p, 'S');
    const myQ = (os: typeof mb) => os.reduce((s, o) => s + (o.qty - o.filled), 0) / unit;
    const tags = [Math.abs(p - last) < 1e-6 ? 'last' : '', p === info?.limit_up ? 'lu' : '', p === info?.limit_down ? 'ld' : '',
      Math.abs(p - p0.avg) < 1e-6 && p0.qty ? 'avg' : '', p === be ? 'be' : ''].filter(Boolean).join(' ');
    return `<div class="td-row ${tags}" data-p="${p}">
      <span class="td-my b" data-act="B">${mb.length ? `<em data-cxl="${mb.map((o) => o.id).join(',')}" title="點一下刪單">${fmt(myQ(mb))}</em>` : ''}</span>
      <span class="td-bv" data-act="B">${b ? `<i style="width:${(b / mx) * 100}%"></i><b>${fmt(b)}</b>` : ''}</span>
      <span class="td-p ${cls(p - ref)}">${fmtP(p)}${p0.qty && Math.abs(p - p0.avg) < 1e-6 ? '<small>均</small>' : p === be ? '<small>平</small>' : ''}</span>
      <span class="td-av" data-act="S">${a ? `<i style="width:${(a / mx) * 100}%"></i><b>${fmt(a)}</b>` : ''}</span>
      <span class="td-my s" data-act="S">${ms.length ? `<em data-cxl="${ms.map((o) => o.id).join(',')}" title="點一下刪單">${fmt(myQ(ms))}</em>` : ''}</span></div>`;
  }).join('') || '<div class="muted td-empty">等待報價…</div>';
}

function msg(text: string, kind: '' | 'ok' | 'err' = '') {
  const el = document.getElementById('td-msg');
  if (el) { el.textContent = text; el.className = `td-msg ${kind}`; }
}

/** 手動下單的數量（張或股，依條件） */
const manualShares = () => {
  const n = Math.round(Number((document.getElementById('td-mq') as HTMLInputElement | null)?.value));
  return n > 0 ? (cond === 'odd' ? n : n * 1000) : NaN;
};

/**
 * 送出模擬委託（只記錄在瀏覽器，不會連線下單）：閃電下單雙擊、手動下單、市價買賣共用
 * 市價：以漲停（買）／跌停（賣）為限價、IOC，能成交的部分以對手價成交
 */
function place(side: Side, price: number, opt: { qty?: number; tif?: Tif; mkt?: boolean; src?: string } = {}) {
  const x = q();
  const qty = opt.qty ?? qtyShares();
  const t: Tif = opt.mkt ? 'IOC' : opt.tif ?? tif;
  const p = curPos();
  let reject = '';
  if (!contract) reject = '尚未載入商品';
  else if (!fin(qty) || qty <= 0) reject = '請輸入數量';
  else if (!fin(price) || price <= 0) reject = '請輸入價格';
  else if (!opt.mkt && Math.abs(snap(price, etf()) - price) > 1e-6) reject = `價格不符合升降單位（最接近 ${fmtP(snap(price, etf()))}）`;
  else if (cond === 'odd' && (qty < 1 || qty > 999)) reject = '零股數量 1–999 股';
  else if (cond !== 'odd' && qty > 499_000) reject = '單筆最多 499 張';
  else if (info && (price > info.limit_up + 1e-6 || price < info.limit_down - 1e-6)) reject = '超出漲跌停';
  else if (side === 'S' && cond !== 'dt') {
    const pending = simBook.working(code).filter((o) => o.side === 'S').reduce((s, o) => s + o.qty - o.filled, 0);
    if (qty + pending > Math.max(0, p.qty)) reject = `${COND_NAME[cond]}賣出超過庫存（可賣 ${fmt(Math.max(0, p.qty - pending))} 股），先賣後買請用「現股當沖」`;
  }
  const o = simBook.place({ code, side, price, qty, cond, tif: t, mkt: opt.mkt },
    { bid: x?.bids[0]?.[0] ?? NaN, ask: x?.asks[0]?.[0] ?? NaN, last: x?.last ?? NaN }, reject || undefined);
  if (opt.mkt && o.status === 'cancelled') o.note = '市價無對手價可成交';
  const fillPx = o.filled ? o.fills.reduce((s, f) => s + f.price * f.qty, 0) / o.filled : NaN;
  const what = `${side === 'B' ? '買進' : '賣出'} ${esc(nameOf(code))} ${cond === 'odd' ? fmt(qty) + ' 股' : fmt(qty / 1000) + ' 張'} @${opt.mkt ? '市價' : fmtP(price)}`;
  if (o.status === 'rejected') msg(`✖ 模擬委託失敗：${o.note}`, 'err');
  else msg(`✓ ${opt.src ?? ''}模擬${COND_NAME[cond]}${what}（${o.status === 'filled' ? `已成交${opt.mkt ? ' ' + fmtP(fillPx) : ''}` : o.status === 'cancelled' ? o.note : `${t} 掛單中`}）`, 'ok');
  dirty = true;
}

function renderOrders() {
  const os = simBook.orders(code).slice().reverse();
  const st = { working: '掛單中', filled: '已成交', cancelled: '已取消', rejected: '失敗' } as const;
  document.getElementById('td-orders')!.innerHTML = os.length ? `<table class="grid td-ot"><tbody>${os.map((o) => {
    const t = new Date(o.at + 8 * 3600_000).toISOString().slice(11, 19);
    const avg = o.fills.length ? o.fills.reduce((s, f) => s + f.price * f.qty, 0) / o.filled : NaN;
    const u = o.cond === 'odd' ? 1 : 1000;
    return `<tr class="td-o-${o.status}"><td class="muted">${t}</td><td class="${o.side === 'B' ? 'up' : 'down'}">${o.side === 'B' ? '買' : '賣'}</td>
      <td>${COND_NAME[o.cond]}</td><td class="r">${o.mkt ? '市價' : fmtP(o.price)}</td><td class="r">${fmt(o.filled / u)}/${fmt(o.qty / u)}${o.cond === 'odd' ? '股' : '張'}</td>
      <td class="r">${fin(avg) ? fmtP(avg) : ''}</td><td>${st[o.status]}${o.note ? `<small class="muted"> ${esc(o.note)}</small>` : ''}</td>
      <td>${o.status === 'working' ? `<button data-cxl="${o.id}">刪單</button>` : ''}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="muted td-empty">今天還沒有模擬委託</div>';
}

// ───────── 右側：走勢、大單、分價、逐筆 ─────────
let ichart: IChartApi | null = null;
let pxLine: ISeriesApi<'Line'> | null = null, vwLine: ISeriesApi<'Line'> | null = null, axisLine: ISeriesApi<'Line'> | null = null;
let ivol: ISeriesApi<'Histogram'> | null = null;
let refSet = false;
let dayBars: Bar[] = [];
let pv = 0, vv = 0;
let fchart: IChartApi | null = null;
let fLines: ISeriesApi<'Line'>[] = [];
let fAxis: ISeriesApi<'Line'> | null = null;
let flowLen = -1, flowAt = 0;
const ROS: ResizeObserver[] = [];
const RANGE = { from: -6, to: 276 };

const base = (logo = true) => ({
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11, attributionLogo: logo },
  grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0 },
  crosshair: { mode: 0 },
} as const);
const fit = (ch: IChartApi | null, id: string) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const el = document.getElementById(id);
  if (!ch || !el || !el.clientWidth) return;
  ch.resize(el.clientWidth, el.clientHeight);
  ch.timeScale().setVisibleLogicalRange(RANGE);
}));

function initCharts() {
  ichart = createChart(document.getElementById('td-ichart')!, { ...base(), rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } }, handleScroll: false, handleScale: false });
  axisLine = ichart.addSeries(LineSeries, { color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  pxLine = ichart.addSeries(LineSeries, { color: '#c9d1d9', lineWidth: 2, priceLineVisible: false });
  vwLine = ichart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ivol = ichart.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  ichart.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  fchart = createChart(document.getElementById('td-fchart')!, { ...base(false), rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
    localization: { priceFormatter: (v: number) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4).toLocaleString() + '萬') },
    handleScroll: false, handleScale: false });
  fAxis = fchart.addSeries(LineSeries, { color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  fLines = [0, 1, 2, 3].map((k) => fchart!.addSeries(LineSeries, { color: TIER_COLOR[k], lineWidth: k >= 2 ? 2 : 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
  fLines[0].createPriceLine({ price: 0, color: 'rgba(139,149,163,.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, title: '' });
  for (const [ch, id] of [[ichart, 'td-ichart'], [fchart, 'td-fchart']] as const) {
    let w = 0;
    const ro = new ResizeObserver(([e]) => { const x = Math.round(e.contentRect.width); if (x && x !== w) { w = x; fit(ch, id); } });
    ro.observe(document.getElementById(id)!);
    ROS.push(ro);
  }
}

function setIntraday(bars: Bar[]): string {
  const day = bars.length ? dstr(bars[bars.length - 1].t) : tpeToday();
  dayBars = bars.filter((b) => dstr(b.t) === day).map((b) => ({ ...b }));
  pv = dayBars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0);
  vv = dayBars.reduce((s, b) => s + b.v, 0);
  let cpv = 0, cvv = 0;
  pxLine?.setData(dayBars.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
  vwLine?.setData(dayBars.map((b) => { cpv += ((b.h + b.l + b.c) / 3) * b.v; cvv += b.v; return { time: b.t as UTCTimestamp, value: cvv ? cpv / cvv : b.c }; }));
  ivol?.setData(dayBars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? cssVar('--up-a') : cssVar('--down-a') })));
  const axis = [];
  for (let m = 9 * 60; m <= 13 * 60 + 30; m++) axis.push({ time: (dayStart(day) + m * 60) as UTCTimestamp });
  axisLine?.setData(axis); fAxis?.setData(axis);
  refSet = false;
  fit(ichart, 'td-ichart'); fit(fchart, 'td-fchart');
  return day;
}

function onTick(t: Tick) {
  if (t.code !== code || t.simtrade) return;
  simBook.onTick(code, t.price, t.vol);
  ticks.push(t);
  if (ticks.length > 20000) ticks.splice(0, 5000);
  const b = Math.ceil(t.t / 60) * 60;
  let bar = dayBars[dayBars.length - 1];
  if (!bar || b > bar.t) { bar = { t: b, o: t.price, h: t.price, l: t.price, c: t.price, v: 0 }; dayBars.push(bar); }
  else if (b < bar.t) return;
  bar.h = Math.max(bar.h, t.price); bar.l = Math.min(bar.l, t.price); bar.c = t.price; bar.v += t.vol;
  pv += t.price * t.vol; vv += t.vol;
  pxLine?.update({ time: b as UTCTimestamp, value: t.price });
  if (vv) vwLine?.update({ time: b as UTCTimestamp, value: pv / vv });
  ivol?.update({ time: b as UTCTimestamp, value: bar.v, color: bar.c >= bar.o ? cssVar('--up-a') : cssVar('--down-a') });
}

const wan = (n: number) => (Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + '億' : Math.round(n / 1e4).toLocaleString() + '萬');
function renderFlow() {
  const buy = [0, 0, 0, 0], sell = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
  for (const t of ticks) {
    const amt = t.price * t.vol * 1000, k = tierOf(amt, t.vol);
    if (t.side === 1) buy[k] += amt; else if (t.side === 2) sell[k] += amt;
    cnt[k]++;
  }
  const net = (k: number) => buy[k] - sell[k];
  document.getElementById('td-big')!.innerHTML = `<table class="grid bigt"><thead><tr><th></th><th class="r">主動買</th><th class="r">主動賣</th><th class="r">淨買</th></tr></thead><tbody>
    ${[3, 2, 1, 0].map((k) => `<tr><td><span class="tag t${k}">${TIER[k]}</span><small class="muted"> ${cnt[k]}筆</small></td>
      <td class="r up">${wan(buy[k])}</td><td class="r down">${wan(sell[k])}</td><td class="r b ${cls(net(k))}">${net(k) >= 0 ? '+' : ''}${wan(net(k))}</td></tr>`).join('')}</tbody></table>`;
  // 累計淨買圖（最多每秒重畫一次）
  const now = performance.now();
  if (!fchart || (ticks.length === flowLen && now - flowAt < 5000) || now - flowAt < 1000) return;
  flowAt = now; flowLen = ticks.length;
  const cum = [0, 0, 0, 0];
  const series: { time: UTCTimestamp; value: number }[][] = [[], [], [], []];
  let cur = 0;
  const flush = () => { for (let k = 0; k < 4; k++) series[k].push({ time: cur as UTCTimestamp, value: cum[k] }); };
  for (const t of ticks) {
    const b = Math.ceil(t.t / 60) * 60;
    if (b !== cur) { if (cur) flush(); cur = b; }
    const amt = t.price * t.vol * 1000, k = tierOf(amt, t.vol);
    if (t.side === 1) cum[k] += amt; else if (t.side === 2) cum[k] -= amt;
  }
  if (cur) flush();
  for (let k = 0; k < 4; k++) fLines[k].setData(series[k]);
  document.getElementById('td-flgd')!.innerHTML = [3, 2, 1, 0].map((k) =>
    `<span><i style="background:${TIER_COLOR[k]}"></i>${TIER[k]} <b class="${cls(cum[k])}">${cum[k] >= 0 ? '+' : ''}${wan(cum[k])}</b></span>`).join('');
}

/** 分價明細：今天每個價位的成交量與外盤比例 */
function renderVP() {
  const m = new Map<number, { v: number; out: number }>();
  for (const t of ticks) {
    const r = m.get(t.price) ?? { v: 0, out: 0 };
    r.v += t.vol; if (t.side === 1) r.out += t.vol;
    m.set(t.price, r);
  }
  const rows = [...m.entries()].sort((a, b) => b[0] - a[0]);
  const mx = Math.max(1, ...rows.map(([, r]) => r.v));
  const last = q()?.last ?? NaN, ref = q()?.ref ?? NaN;
  document.getElementById('td-vp')!.innerHTML = rows.map(([p, r]) => `<div class="td-vr${Math.abs(p - last) < 1e-6 ? ' last' : ''}">
    <span class="${cls(p - ref)}">${fmtP(p)}</span><span class="td-vb"><i style="width:${(r.v / mx) * 100}%"></i></span><span>${fmt(r.v)}</span>
    <span class="muted">${Math.round((r.out / r.v) * 100)}%</span></div>`).join('') || '<div class="muted">尚無成交</div>';
}

function renderTicks() {
  const out: string[] = [];
  for (let i = ticks.length - 1; i >= 0 && out.length < 80; i--) {
    const t = ticks[i], k = tierOf(t.price * t.vol * 1000, t.vol);
    out.push(`<div class="tk-r${k ? ' big' + k : ''}"><span class="tm">${new Date(t.t * 1000).toISOString().slice(11, 19)}</span>
      <span class="pr ${t.side === 1 ? 'up' : t.side === 2 ? 'down' : ''}">${fmtP(t.price)}</span><span class="vl">${fmt(t.vol)}</span>
      <span class="sd ${t.side === 1 ? 'up' : 'down'}">${t.side === 1 ? '外' : t.side === 2 ? '內' : ''}</span>
      <span class="tg">${k ? `<span class="tag t${k}">${TIER[k]}</span>` : ''}</span></div>`);
  }
  document.getElementById('td-ticks')!.innerHTML = out.join('') || '<div class="muted">尚無成交</div>';
}

// ───────── 主迴圈 ─────────
function applyCtl() {
  document.querySelectorAll<HTMLElement>('#td-cond button').forEach((b) => b.classList.toggle('on', b.dataset.c === cond));
  document.querySelectorAll<HTMLElement>('#td-tif button').forEach((b) => b.classList.toggle('on', b.dataset.t === tif));
  document.getElementById('td-unit')!.textContent = cond === 'odd' ? '股' : '張';
  document.querySelector('.td-munit')!.textContent = cond === 'odd' ? '股' : '張';
  (document.getElementById('td-mq') as HTMLInputElement).max = cond === 'odd' ? '999' : '499';
  mktLabel();
  const presets = cond === 'odd' ? [1, 10, 50, 100, 500] : [1, 2, 5, 10, 20];
  document.getElementById('td-quick')!.innerHTML = presets.map((n) => `<button data-n="${n}">${n}</button>`).join('');
  const inp = document.getElementById('td-n') as HTMLInputElement;
  inp.max = cond === 'odd' ? '999' : '499';
}

/** 市價按鈕上顯示數量（＝閃電下單設定） */
function mktLabel() {
  const n = qtyShares();
  document.querySelectorAll('.td-mkq').forEach((e) => { e.textContent = cond === 'odd' ? `${fmt(n)} 股` : `${fmt(n / 1000)} 張`; });
}

function frame() {
  if (!mounted) return;
  if (dirty && code && !pointerHeld() && performance.now() > holdRender) {
    dirty = false;
    renderHead(); renderPos(); renderCalc(); renderLadder(); renderOrders();
    renderFlow(); renderVP(); renderTicks();
    const ref = q()?.ref ?? info?.reference ?? NaN;
    if (!refSet && pxLine && fin(ref)) { refSet = true; pxLine.createPriceLine({ price: ref, color: cssVar('--muted'), lineStyle: LineStyle.Dashed, lineWidth: 1, title: '參考' }); }
  }
  timer = setTimeout(() => requestAnimationFrame(frame), 300);
}

function suggest(s: string) {
  const box = document.getElementById('td-sug')!;
  s = s.trim();
  if (!s) { box.hidden = true; return; }
  const hits = catalog.search(s, 8);
  box.innerHTML = hits.map((h) => `<div data-code="${h.code}"><b>${esc(h.name)}</b> ${h.code}</div>`).join('');
  box.hidden = !hits.length;
}

function bind(el: HTMLElement) {
  const inp = el.querySelector<HTMLInputElement>('#td-q')!;
  inp.addEventListener('focus', () => catalog.ensure());
  inp.addEventListener('input', () => suggest(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = el.querySelector<HTMLElement>('#td-sug [data-code]')?.dataset.code ?? inp.value;
    inp.value = ''; suggest(''); open(first);
  });
  inp.addEventListener('blur', () => setTimeout(() => suggest(''), 150));
  el.querySelector('#td-sug')!.addEventListener('mousedown', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-code]')?.dataset.code;
    if (c) { inp.value = ''; suggest(''); open(c); }
  });
  el.querySelector('#td-cond')!.addEventListener('click', (e) => {
    const c = (e.target as HTMLElement).dataset.c as Cond | undefined;
    if (!c) return;
    cond = c; LS.set('tdCond', c); applyCtl(); dirty = true;
  });
  el.querySelector('#td-tif')!.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).dataset.t as Tif | undefined;
    if (t) { tif = t; LS.set('tdTif', t); applyCtl(); }
  });
  el.querySelector('#td-quick')!.addEventListener('click', (e) => {
    const n = (e.target as HTMLElement).dataset.n;
    if (n) { (el.querySelector('#td-n') as HTMLInputElement).value = n; dirty = true; }
  });
  el.querySelector('#td-n')!.addEventListener('input', () => { dirty = true; mktLabel(); });
  // 手動下單：輸入價格／數量／ROD・IOC → 送出
  el.querySelector('.td-man')!.addEventListener('click', (e) => {
    const side = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m as Side | undefined;
    if (!side) return;
    const price = Number((el.querySelector('#td-mp') as HTMLInputElement).value);
    place(side, price, { qty: manualShares(), tif: (el.querySelector('#td-mtif') as HTMLSelectElement).value as Tif, src: '手動 ' });
  });
  // 市價買進／賣出：數量＝閃電下單設定
  el.querySelector('.td-mkt')!.addEventListener('click', (e) => {
    const side = (e.target as HTMLElement).closest<HTMLElement>('[data-k]')?.dataset.k as Side | undefined;
    if (!side) return;
    const x = q();
    const px = side === 'B' ? info?.limit_up ?? x?.asks[0]?.[0] ?? NaN : info?.limit_down ?? x?.bids[0]?.[0] ?? NaN;
    place(side, px, { mkt: true });
  });
  el.querySelector('#td-center')!.addEventListener('click', () => { center = NaN; follow = true; dirty = true; });
  el.querySelector('#td-cxl')!.addEventListener('click', () => { simBook.cancelAll(code); msg('已刪除這檔全部模擬掛單', 'ok'); });
  el.querySelector('#td-clear')!.addEventListener('click', () => { if (confirm('清除今天全部模擬委託與成交紀錄？')) simBook.clear(); });
  el.querySelector('#td-orders')!.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cxl]')?.dataset.cxl;
    if (id) simBook.cancel(Number(id));
  });
  const lad = el.querySelector<HTMLElement>('#td-ladder')!;
  // 雙擊判斷自己做：兩次點擊間畫面可能重繪，原生 dblclick 會失效（pitfalls #12）
  lad.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    holdRender = performance.now() + 450;
    const cx = t.closest<HTMLElement>('[data-cxl]')?.dataset.cxl;
    if (t.closest('.td-p')) {                                   // 單擊價格＝帶入手動下單價格
      const pp = Number(t.closest<HTMLElement>('[data-p]')?.dataset.p);
      if (fin(pp)) { (document.getElementById('td-mp') as HTMLInputElement).value = String(pp); msg(`手動價格已帶入 ${fmtP(pp)}`); }
      return;
    }
    if (cx) { cx.split(',').forEach((id) => simBook.cancel(Number(id))); msg('已刪除該價位的模擬掛單', 'ok'); lastClick = { at: 0, key: '' }; return; }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act as Side | undefined;
    const p = Number(t.closest<HTMLElement>('[data-p]')?.dataset.p);
    if (!act || !fin(p)) return;
    const key = `${act}@${p}`;
    if (key === lastClick.key && performance.now() - lastClick.at < 450) { lastClick = { at: 0, key: '' }; holdRender = 0; place(act, p); }
    else lastClick = { at: performance.now(), key };
  });
  lad.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!fin(center)) return;
    follow = false;
    const n = Math.max(1, Math.round(Math.abs(e.deltaY) / 60));
    for (let i = 0; i < n; i++) center = e.deltaY < 0 ? stepUp(center, etf()) : stepDown(center, etf());
    dirty = true;
  }, { passive: false });
}

const codeFromHash = () => location.hash.replace(/^#\/?trade\/?/, '').split(/[/?]/)[0];

export const tradePage: Page = {
  id: 'trade',
  title: '下單',
  mount(el) {
    mounted = true; dirty = true;
    el.innerHTML = TEMPLATE;
    bind(el); applyCtl(); initCharts();
    account.use(OWNER);
    cleanups.push(hub.on('change', () => { dirty = true; }));
    cleanups.push(hub.on('tick', onTick));
    cleanups.push(account.on(() => { dirty = true; }));
    cleanups.push(simBook.on(() => { dirty = true; }));
    const onHash = () => { const c = codeFromHash(); if (location.hash.startsWith('#/trade') && c) open(c); };
    window.addEventListener('hashchange', onHash);
    cleanups.push(() => window.removeEventListener('hashchange', onHash));
    code = '';
    open(codeFromHash() || LS.get('tdCode') || '2330');
    frame();
  },
  unmount() {
    mounted = false; seq++;
    clearTimeout(timer);
    cleanups.splice(0).forEach((f) => f());
    hub.releaseAll(OWNER);
    account.unuse(OWNER);
    ROS.splice(0).forEach((r) => r.disconnect());
    ichart?.remove(); fchart?.remove();
    ichart = fchart = null; pxLine = vwLine = axisLine = fAxis = null; ivol = null; fLines = [];
    contract = null; code = '';
  },
};
