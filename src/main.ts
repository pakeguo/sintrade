import './style.css';
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineStyle,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp,
} from 'lightweight-charts';
import { LiveBackend } from './api';
import { delta as bsDelta, impliedVol, yearsToExpiry } from './bs';
import { DemoBackend } from './mock';
import type { Backend, Bar, BidAsk, ConnStatus, Contract, IndexQuote, OptContract, Tick } from './types';

// ───────────────────────── 狀態 ─────────────────────────
interface Q {
  last: number; ref: number; vol: number; high: number; low: number;
  bids: [number, number][]; asks: [number, number][];
  flash: number; dir: 0 | 1 | -1;
}
interface Expiry {
  key: string; root: string; date: string; label: string; kind: string; list: OptContract[];
}

const LS = {
  get: (k: string) => { try { return localStorage.getItem('mw.' + k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem('mw.' + k, v); } catch { /* ignore */ } },
};

let be: Backend;
let env: 'sim' | 'prod' | 'demo' = 'demo';
const quotes = new Map<string, Q>();
let idx: IndexQuote | null = null;
let fut: Contract | null = null;          // TXFR1（含 target_code）
let futKey = '';                          // 實際月份代碼，tick 以此回報
let expiries: Expiry[] = [];
let cur: Expiry | null = null;
let range = Number(LS.get('range') ?? 10);
let center = NaN;                         // 目前 T 字報價的中心履約價
let visible: OptContract[] = [];
let selected: Contract | null = null;
let selectedName = '';
let dirty = true;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function q(code: string): Q {
  let x = quotes.get(code);
  if (!x) {
    x = { last: NaN, ref: NaN, vol: 0, high: NaN, low: NaN, bids: [], asks: [], flash: 0, dir: 0 };
    quotes.set(code, x);
  }
  return x;
}

// ───────────────────────── 格式化 ─────────────────────────
const fin = (n: number) => Number.isFinite(n);
function fmt(n: number, d = 0): string {
  if (!fin(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtP(n: number): string {
  if (!fin(n)) return '—';
  return n >= 100 ? fmt(n, 0) : n >= 10 ? fmt(n, 1) : fmt(n, n % 1 ? (Math.round(n * 10) === n * 10 ? 1 : 2) : 1);
}
function sign(n: number, d = 0) { return !fin(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d); }
const cls = (n: number) => (!fin(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down');
function fmtVol(n: number) {
  if (!fin(n) || n <= 0) return '';
  return n >= 10000 ? (n / 10000).toFixed(1) + '萬' : fmt(n);
}

// ───────────────────────── 核心計算 ─────────────────────────
/** 可用於計算的「公平價」：五檔中價優先（價差合理時），否則最近成交價 */
function fair(code: string): number {
  const x = quotes.get(code);
  if (!x) return NaN;
  const b = x.bids[0]?.[0], a = x.asks[0]?.[0];
  if (b > 0 && a > 0 && a >= b) {
    const mid = (a + b) / 2;
    if (a - b <= Math.max(mid * 0.25, 2)) return mid;
  }
  return x.last;
}

interface Row { k: number; c?: OptContract; p?: OptContract }

function rowsOf(e: Expiry): Row[] {
  const m = new Map<number, Row>();
  for (const o of e.list) {
    const r = m.get(o.strike) ?? { k: o.strike };
    if (o.right === 'C') r.c = o; else r.p = o;
    m.set(o.strike, r);
  }
  return [...m.values()].sort((a, b) => a.k - b.k);
}

let rowsCache: { e: Expiry; rows: Row[] } | null = null;
function rows(): Row[] {
  if (!cur) return [];
  if (rowsCache?.e !== cur) rowsCache = { e: cur, rows: rowsOf(cur) };
  return rowsCache.rows;
}

function futLast() { return quotes.get(futKey)?.last ?? NaN; }

/** 合成期貨 F = K + C − P（取最接近價平的 3 檔平均），這是該到期的真正標的價格 */
function synthetic(): number {
  const base = fin(futLast()) ? futLast() : idx?.close ?? NaN;
  if (!fin(base)) return NaN;
  const rs = rows().filter((r) => r.c && r.p)
    .sort((a, b) => Math.abs(a.k - base) - Math.abs(b.k - base)).slice(0, 3);
  const vals = rs.map((r) => r.k + fair(r.c!.code) - fair(r.p!.code)).filter(fin);
  if (!vals.length) return base;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

interface Metrics {
  F: number; T: number; atm?: Row; straddle: number; atmIV: number; skew: number;
  pcr: number; callVol: number; putVol: number; maxCall?: Row; maxPut?: Row;
  iv: Map<string, number>; dl: Map<string, number>; maxVol: number;
}

function metrics(): Metrics {
  const F = synthetic();
  const T = cur ? yearsToExpiry(cur.date) : NaN;
  const all = rows();
  const iv = new Map<string, number>(), dl = new Map<string, number>();
  let callVol = 0, putVol = 0, maxVol = 0;
  let maxCall: Row | undefined, maxPut: Row | undefined;
  for (const r of all) {
    for (const o of [r.c, r.p]) {
      if (!o) continue;
      const v = quotes.get(o.code)?.vol ?? 0;
      if (o.right === 'C') { callVol += v; if (!maxCall || v > (quotes.get(maxCall.c!.code)?.vol ?? 0)) maxCall = r; }
      else { putVol += v; if (!maxPut || v > (quotes.get(maxPut.p!.code)?.vol ?? 0)) maxPut = r; }
      if (v > maxVol) maxVol = v;
      const s = impliedVol(fair(o.code), F, o.strike, T, o.right);
      iv.set(o.code, s);
      if (fin(s)) dl.set(o.code, bsDelta(F, o.strike, T, s, o.right));
    }
  }
  const atm = all.filter((r) => r.c && r.p).sort((a, b) => Math.abs(a.k - F) - Math.abs(b.k - F))[0];
  const straddle = atm ? fair(atm.c!.code) + fair(atm.p!.code) : NaN;
  const atmIV = atm ? avg([iv.get(atm.c!.code)!, iv.get(atm.p!.code)!]) : NaN;
  // 25 Delta 偏斜：Put(Δ≈−0.25) IV − Call(Δ≈+0.25) IV
  const near = (right: 'C' | 'P', target: number) => {
    let best: string | undefined, bd = 1;
    for (const [code, d] of dl) {
      if ((right === 'C') !== d > 0) continue;
      if (Math.abs(d - target) < bd) { bd = Math.abs(d - target); best = code; }
    }
    return best && bd < 0.12 ? iv.get(best)! : NaN;
  };
  const skew = (near('P', -0.25) - near('C', 0.25)) * 100;
  return {
    F, T, atm, straddle, atmIV, skew, pcr: callVol ? putVol / callVol : NaN,
    callVol, putVol, maxCall, maxPut, iv, dl, maxVol,
  };
}

function avg(a: number[]) {
  const v = a.filter(fin);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}

// ───────────────────────── 資料載入 ─────────────────────────
function tpeToday(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

async function loadExpiries() {
  const roots = await be.optionRoots();
  // 臺指選擇權家族：月選 TXO + 各週選（名稱為「臺指選擇權…」或 TX1–TX5）
  const fam = roots.filter((r) => r.root === 'TXO' || /^TX[1-5]$/.test(r.root) || r.name.startsWith('臺指選擇權'));
  const lists = await Promise.all(fam.map((r) => be.optionChain(r.root).catch((e) => {
    if (r.root === 'TXO') throw e; // 月選都拿不到，代表 server 還沒就緒 → 交給 retry
    return [] as OptContract[];
  })));
  const today = tpeToday();
  const tpe = new Date(Date.now() + 8 * 3600_000);
  const afterClose = tpe.getUTCHours() * 60 + tpe.getUTCMinutes() > 13 * 60 + 45;
  const groups = new Map<string, Expiry>();
  for (const list of lists) {
    for (const o of list) {
      if (o.delivery_date < today || (o.delivery_date === today && afterClose)) continue;
      const key = `${o.root}:${o.delivery_date}`;
      let g = groups.get(key);
      if (!g) {
        const wd = new Date(o.delivery_date + 'T00:00:00Z').getUTCDay();
        const kind = o.root === 'TXO' ? '月選' : wd === 3 ? '週三' : wd === 5 ? '週五' : '週選';
        const [, m, d] = o.delivery_date.split('-');
        g = { key, root: o.root, date: o.delivery_date, kind, label: `${+m}/${+d}`, list: [] };
        groups.set(key, g);
      }
      g.list.push(o);
    }
  }
  expiries = [...groups.values()].filter((g) => g.list.length >= 10)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.root === 'TXO' ? 1 : -1)).slice(0, 8);
  const saved = LS.get('expiryRoot');
  cur = expiries.find((e) => e.root === saved) ?? expiries[0] ?? null;
}

async function loadSnapshots(list: Contract[]) {
  try {
    const snaps = await be.snapshots(list);
    for (const s of snaps) {
      // 連續月（TXFR1）的快照回傳 TXFR1，即時 tick 則用實際月份代碼 → 統一存到 futKey
      const x = q(fut && (s.code === fut.code || s.code === futKey) ? futKey : s.code);
      if (fin(s.close) && s.close > 0) x.last = s.close;
      const r = s.close - s.change_price;
      if (fin(r) && r > 0) x.ref = r;
      x.vol = Math.max(x.vol, s.total_volume || 0);
      x.high = s.high; x.low = s.low;
    }
    dirty = true;
  } catch (e) { console.warn('snapshots', e); }
}

const subscribed = new Set<string>();
async function setVisible(next: OptContract[]) {
  const want = new Set(next.map((o) => o.code));
  for (const o of visible) {
    if (!want.has(o.code) && subscribed.has(o.code)) {
      subscribed.delete(o.code);
      be.unsubscribe(o, 'Tick'); be.unsubscribe(o, 'BidAsk');
    }
  }
  visible = next;
  for (const o of next) {
    if (subscribed.has(o.code)) continue;
    subscribed.add(o.code);
    be.subscribe(o, 'Tick').catch((e) => console.warn(e));
    be.subscribe(o, 'BidAsk').catch((e) => console.warn(e));
  }
  dirty = true;
}

/** 以價平為中心挑出上下各 range 檔 */
async function recenter(force = false) {
  if (!cur) return;
  const F = synthetic();
  const all = rows();
  if (!all.length || !fin(F)) return;
  let i = all.findIndex((r) => r.k >= F);
  if (i < 0) i = all.length - 1;
  const k = all[i].k;
  if (!force && fin(center)) {
    const ci = all.findIndex((r) => r.k === center);
    if (Math.abs(ci - i) < 3) return;   // 價平偏移 3 檔以上才重新置中，避免畫面跳動
  }
  center = k;
  const slice = all.slice(Math.max(0, i - range), i + range + 1);
  await setVisible(slice.flatMap((r) => [r.c, r.p].filter(Boolean) as OptContract[]));
}

async function selectExpiry(e: Expiry) {
  cur = e;
  LS.set('expiryRoot', e.root);
  center = NaN;
  renderExpiries();
  await loadSnapshots(e.list);
  await recenter(true);
}

// ───────────────────────── 即時事件 ─────────────────────────
function onTick(t: Tick) {
  if (t.simtrade) return; // 試撮不列入
  const x = q(t.code);
  if (fin(x.last) && t.price !== x.last) { x.dir = t.price > x.last ? 1 : -1; x.flash = performance.now(); }
  x.last = t.price;
  if (fin(t.totalVol)) x.vol = t.totalVol;
  if (fin(t.high ?? NaN)) x.high = t.high!;
  if (fin(t.low ?? NaN)) x.low = t.low!;
  dirty = true;
  if (selected && keyOf(selected) === t.code) chartTick(t);
}
function onBidAsk(b: BidAsk) {
  if (b.simtrade) return;
  const x = q(b.code);
  x.bids = b.bids; x.asks = b.asks;
  dirty = true;
}
function onIndex(i: IndexQuote) {
  if (i.code !== 'IX0001') return;
  idx = i;
  dirty = true;
}
function onStatus(s: ConnStatus) {
  const el = $('conn');
  el.className = 'conn ' + s;
  el.textContent = { connecting: '連線中…', live: '即時', down: '斷線・重連中', demo: 'DEMO' }[s];
}

const keyOf = (c: Contract) => c.target_code || c.code;

// ───────────────────────── 繪製：指標卡 ─────────────────────────
function card(id: string, title: string, main: string, sub: string, mainCls = '', tip = '') {
  const el = $(id);
  el.innerHTML = `<div class="ct">${title}${tip ? `<span class="tip" title="${tip}">?</span>` : ''}</div>
    <div class="cm ${mainCls}">${main}</div><div class="cs">${sub}</div>`;
}

function renderCards(m: Metrics) {
  // 1. 加權指數
  if (idx) {
    const ch = idx.close - idx.reference;
    card('c-idx', '加權指數', fmt(idx.close, 2),
      `<span class="${cls(ch)}">${sign(ch, 2)}　${sign((ch / idx.reference) * 100, 2)}%</span>
       ${fin(idx.raise) ? `<div class="breadth"><span class="up">▲${fmt(idx.raise + idx.raiseStop)}</span>
       <span class="flat">${fmt(idx.flat)}</span><span class="down">▼${fmt(idx.fall + idx.fallStop)}</span></div>` : ''}`,
      cls(ch));
  }
  // 2. 台指期
  const f = quotes.get(futKey);
  if (f) {
    const ch = f.last - f.ref;
    const basis = idx ? f.last - idx.close : NaN;
    const basisHtml = session() === 'day'
      ? `基差 <b class="${cls(basis)}">${sign(basis, 1)}</b> ${fin(basis) ? (basis >= 0 ? '正價差' : '逆價差') : ''}`
      : `較現貨收盤 <b class="${cls(basis)}">${sign(basis, 0)}</b>`;
    card('c-fut', '台指期 近月', fmt(f.last),
      `<span class="${cls(ch)}">${sign(ch)}　${sign((ch / f.ref) * 100, 2)}%</span>
       <div>${basisHtml}</div>`,
      cls(ch), '日盤：基差 = 期貨 − 現貨，正價差偏樂觀、逆價差偏保守（也受除息影響）。夜盤時現貨已收盤，改顯示期貨相對現貨收盤價的變動。');
  }
  // 3. 到期
  if (cur) {
    const hrs = m.T * 365 * 24;
    const left = hrs >= 24 ? `${Math.floor(hrs / 24)} 天 ${Math.floor(hrs % 24)} 時` : `${Math.floor(hrs)} 時 ${Math.floor((hrs * 60) % 60)} 分`;
    card('c-exp', `${cur.kind}到期`, left, `${cur.date}（${cur.root}）13:30`,
      hrs < 24 ? 'warn' : '', '距最後交易時刻的剩餘時間。越接近到期，時間價值流失越快。');
  }
  // 4. 價平 / 合成期貨
  card('c-atm', '價平履約價', m.atm ? fmt(m.atm.k) : '—',
    `合成期貨 <b>${fmt(m.F, 1)}</b>`, '',
    '合成期貨 = 履約價 + Call − Put，是這個到期別選擇權真正對應的標的價格，IV 與 Delta 都以它計算。');
  // 5. 預期區間
  const lo = m.F - m.straddle, hi = m.F + m.straddle;
  card('c-move', '到期預期區間', fin(m.straddle) ? `±${fmt(m.straddle, 0)}` : '—',
    fin(m.straddle) ? `${fmt(lo)} ～ ${fmt(hi)}　(±${((m.straddle / m.F) * 100).toFixed(2)}%)` : '',
    'accent', '價平跨式（價平 Call + Put）價格，是市場對到期前波動幅度的定價，約等於一個標準差區間。');
  // 6. IV
  const ivTxt = fin(m.atmIV) ? (m.atmIV * 100).toFixed(1) + '%' : '—';
  const skTxt = fin(m.skew) ? `${m.skew > 0 ? '+' : ''}${m.skew.toFixed(1)}` : '—';
  const skLbl = !fin(m.skew) ? '' : m.skew > 3 ? '避險需求強' : m.skew < 0 ? 'Call 追價' : '正常';
  card('c-iv', '價平 IV', ivTxt, `偏斜 <b>${skTxt}</b> ${skLbl}`, '',
    '價平隱含波動率：選擇權貴或便宜的溫度計。偏斜 = 25Δ Put IV − 25Δ Call IV，越大代表市場越願意花錢買下跌保護。');
  // 7. P/C
  const pcLbl = !fin(m.pcr) ? '' : m.pcr > 1.2 ? 'Put 量明顯多' : m.pcr < 0.8 ? 'Call 量明顯多' : '均衡';
  const cw = m.callVol + m.putVol ? (m.callVol / (m.callVol + m.putVol)) * 100 : 50;
  card('c-pcr', 'P/C 成交量比', fin(m.pcr) ? m.pcr.toFixed(2) : '—',
    `${pcLbl}<div class="pcbar"><i style="width:${cw}%"></i></div>
     <div class="pcl"><span class="up">C ${fmtVol(m.callVol)}</span><span class="down">P ${fmtVol(m.putVol)}</span></div>`,
    '', '全部履約價 Put 總成交量 ÷ Call 總成交量（本到期別、今日）。');
  // 8. 壓力 / 支撐
  const cv = m.maxCall ? quotes.get(m.maxCall.c!.code)?.vol ?? 0 : 0;
  const pv = m.maxPut ? quotes.get(m.maxPut.p!.code)?.vol ?? 0 : 0;
  card('c-wall', '量能壓力 / 支撐',
    `<div class="wl"><small>壓</small><span class="up">${m.maxCall ? fmt(m.maxCall.k) : '—'}</span><em>${fmtVol(cv)}</em></div>
     <div class="wl"><small>撐</small><span class="down">${m.maxPut ? fmt(m.maxPut.k) : '—'}</span><em>${fmtVol(pv)}</em></div>`,
    '',
    '', '依今日成交量：Call 最大量履約價常被視為上方壓力、Put 最大量履約價為下方支撐（API 不提供未平倉量，這裡以成交量代替）。');
}

// ───────────────────────── 繪製：T 字報價 ─────────────────────────
function renderChain(m: Metrics) {
  const body = $('chain-body');
  if (!cur || !visible.length) { body.innerHTML = '<tr><td colspan="11" class="empty">載入中…</td></tr>'; return; }
  const vset = new Set(visible.map((o) => o.code));
  const rs = rows().filter((r) => (r.c && vset.has(r.c.code)) || (r.p && vset.has(r.p.code)));
  const now = performance.now();
  const maxV = Math.max(1, ...rs.flatMap((r) => [r.c, r.p].map((o) => (o ? quotes.get(o.code)?.vol ?? 0 : 0))));
  const lo = m.F - m.straddle, hi = m.F + m.straddle;
  const sel = selected ? keyOf(selected) : '';
  let html = '';
  let markerDone = false;
  for (const r of rs) {
    if (!markerDone && fin(m.F) && r.k > m.F) {
      html += fline(m.F);
      markerDone = true;
    }
    const isAtm = m.atm?.k === r.k;
    const inBand = fin(m.straddle) && r.k >= lo && r.k <= hi;
    const side = (o: OptContract | undefined, right: 'C' | 'P') => {
      if (!o) return '<td></td>'.repeat(5);
      const x = quotes.get(o.code);
      const v = x?.vol ?? 0;
      const last = x?.last ?? NaN, ch = last - (x?.ref ?? NaN);
      const iv = m.iv.get(o.code) ?? NaN, d = m.dl.get(o.code) ?? NaN;
      const fl = x && now - x.flash < 700 ? (x.dir > 0 ? ' fu' : ' fd') : '';
      const w = (v / maxV) * 100;
      const wall = (right === 'C' ? m.maxCall : m.maxPut)?.k === r.k ? ' wall' : '';
      const volTd = `<td class="vol ${right}${wall}"><i style="width:${w}%"></i><span>${fmtVol(v)}</span></td>`;
      const cells = [
        volTd,
        `<td class="iv">${fin(iv) ? (iv * 100).toFixed(1) : '—'}</td>`,
        `<td class="dl">${fin(d) ? d.toFixed(2) : '—'}</td>`,
        `<td class="chg ${cls(ch)}">${sign(ch, Math.abs(ch) < 10 && ch % 1 ? 1 : 0)}</td>`,
        `<td class="px ${cls(ch)}${fl}${sel === o.code ? ' sel' : ''}" data-code="${o.code}">${fmtP(last)}</td>`,
      ];
      return (right === 'C' ? cells : cells.reverse()).join('');
    };
    const itmC = fin(m.F) && r.k < m.F, itmP = fin(m.F) && r.k > m.F;
    html += `<tr class="${isAtm ? 'atm' : ''}${inBand ? ' band' : ''}">`
      + side(r.c, 'C').replace(/<td/g, `<td data-side="C"${itmC ? ' data-itm="1"' : ''}`)
      + `<td class="k">${fmt(r.k)}${isAtm ? '<em>價平</em>' : ''}</td>`
      + side(r.p, 'P').replace(/<td/g, `<td data-side="P"${itmP ? ' data-itm="1"' : ''}`)
      + '</tr>';
  }
  if (!markerDone && fin(m.F)) html += fline(m.F);
  body.innerHTML = html;
}

const fline = (F: number) => {
  const n = compactMq.matches ? 3 : 5;
  return `<tr class="fline"><td colspan="${n}"></td><td class="fk">◆ ${fmt(F, 1)}</td><td colspan="${n}"></td></tr>`;
};

function renderExpiries() {
  $('expiries').innerHTML = expiries.map((e) => {
    const days = Math.ceil(yearsToExpiry(e.date) * 365);
    return `<button class="chip${e === cur ? ' on' : ''}" data-key="${e.key}">
      <b>${e.label}</b> ${e.kind}<small>${days <= 1 ? '今明' : days + '天'}</small></button>`;
  }).join('') || '<span class="muted">找不到臺指選擇權到期合約</span>';
}

// ───────────────────────── 右側：選定商品 ─────────────────────────
let chart: IChartApi | null = null;
let candle: ISeriesApi<'Candlestick'> | null = null;
let volS: ISeriesApi<'Histogram'> | null = null;
let refLine: IPriceLine | null = null;
let lastBar: Bar | null = null;

function cssVar(n: string) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function ensureChart() {
  if (chart) return;
  const el = $('chart');
  chart = createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11 },
    grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  });
  candle = chart.addSeries(CandlestickSeries, {
    upColor: cssVar('--up'), downColor: cssVar('--down'), borderVisible: false,
    wickUpColor: cssVar('--up'), wickDownColor: cssVar('--down'),
  });
  volS = chart.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
}

async function select(c: Contract, name: string) {
  if (selected && keyOf(selected) !== futKey && !visible.some((o) => o.code === keyOf(selected!))) {
    be.unsubscribe(selected, 'Tick'); be.unsubscribe(selected, 'BidAsk');
  }
  selected = c; selectedName = name; lastBar = null;
  be.subscribe(c, 'Tick').catch(() => undefined);
  be.subscribe(c, 'BidAsk').catch(() => undefined);
  ensureChart();
  candle!.setData([]); volS!.setData([]);
  dirty = true;
  try {
    const bars = await be.kbars(c, tpeToday(-6), tpeToday());
    if (selected !== c) return;
    // 只顯示最後一個交易時段（期貨夜盤 15:00 後歸到下一交易日）
    const session = (t: number) => {
      const d = new Date(t * 1000);
      const h = d.getUTCHours();
      if (h >= 15) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const lastS = bars.length ? session(bars[bars.length - 1].t) : '';
    const day = bars.filter((b) => session(b.t) === lastS);
    candle!.setData(day.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    volS!.setData(day.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? cssVar('--up-a') : cssVar('--down-a') })));
    lastBar = day.length ? { ...day[day.length - 1] } : null;
    chart!.timeScale().fitContent();
    const r = quotes.get(keyOf(c))?.ref;
    if (refLine) candle!.removePriceLine(refLine);
    refLine = fin(r ?? NaN) ? candle!.createPriceLine({ price: r!, color: cssVar('--muted'), lineStyle: LineStyle.Dashed, lineWidth: 1, title: '參考價' }) : null;
  } catch (e) { console.warn('kbars', e); }
}

function chartTick(t: Tick) {
  if (!candle) return;
  const bucket = Math.ceil(t.t / 60) * 60; // shioaji 1 分 K 以結束時間標記
  if (!lastBar || bucket > lastBar.t) {
    lastBar = { t: bucket, o: t.price, h: t.price, l: t.price, c: t.price, v: t.vol };
  } else if (bucket === lastBar.t) {
    lastBar.h = Math.max(lastBar.h, t.price); lastBar.l = Math.min(lastBar.l, t.price);
    lastBar.c = t.price; lastBar.v += t.vol;
  } else return;
  const b = lastBar;
  candle.update({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c });
  volS!.update({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? cssVar('--up-a') : cssVar('--down-a') });
}

function renderDetail(m: Metrics) {
  if (!selected) return;
  const k = keyOf(selected);
  const x = quotes.get(k);
  const opt = cur?.list.find((o) => o.code === k);
  const ch = (x?.last ?? NaN) - (x?.ref ?? NaN);
  let extra = '';
  if (opt && fin(m.F)) {
    const intrinsic = Math.max(0, opt.right === 'C' ? m.F - opt.strike : opt.strike - m.F);
    const tv = fair(k) - intrinsic;
    const iv = m.iv.get(k) ?? NaN, d = m.dl.get(k) ?? NaN;
    const be2 = opt.right === 'C' ? opt.strike + (x?.last ?? NaN) : opt.strike - (x?.last ?? NaN);
    extra = `<div class="kv"><span>IV</span><b>${fin(iv) ? (iv * 100).toFixed(1) + '%' : '—'}</b></div>
      <div class="kv"><span>Delta</span><b>${fin(d) ? d.toFixed(2) : '—'}</b></div>
      <div class="kv"><span>內含價值</span><b>${fmt(intrinsic, 1)}</b></div>
      <div class="kv"><span>時間價值</span><b>${fmt(tv, 1)}</b></div>
      <div class="kv"><span>損益兩平</span><b>${fmt(be2, 0)}</b></div>
      <div class="kv"><span>每點價值</span><b>50 元</b></div>`;
  }
  $('d-head').innerHTML = `<div class="dn">${selectedName}</div>
    <div class="dp ${cls(ch)}">${fmtP(x?.last ?? NaN)}<small>${sign(ch, Math.abs(ch) < 10 && ch % 1 ? 1 : 0)}　${x ? sign((ch / x.ref) * 100, 2) + '%' : ''}</small></div>
    <div class="grid2"><div class="kv"><span>最高</span><b class="up">${fmtP(x?.high ?? NaN)}</b></div>
    <div class="kv"><span>最低</span><b class="down">${fmtP(x?.low ?? NaN)}</b></div>
    <div class="kv"><span>總量</span><b>${fmt(x?.vol ?? NaN)}</b></div>
    <div class="kv"><span>參考價</span><b>${fmtP(x?.ref ?? NaN)}</b></div>${extra}</div>`;
  // 五檔
  const bids = x?.bids ?? [], asks = x?.asks ?? [];
  const mx = Math.max(1, ...bids.map((b) => b[1]), ...asks.map((a) => a[1]));
  let h = '';
  for (let i = 4; i >= 0; i--) {
    const a = asks[i];
    h += `<div class="lv ask"><span class="p">${a ? fmtP(a[0]) : ''}</span><span class="v"><i style="width:${a ? (a[1] / mx) * 100 : 0}%"></i>${a ? a[1] : ''}</span></div>`;
  }
  for (let i = 0; i < 5; i++) {
    const b = bids[i];
    h += `<div class="lv bid"><span class="p">${b ? fmtP(b[0]) : ''}</span><span class="v"><i style="width:${b ? (b[1] / mx) * 100 : 0}%"></i>${b ? b[1] : ''}</span></div>`;
  }
  const sb = bids.reduce((s, b) => s + b[1], 0), sa = asks.reduce((s, a) => s + a[1], 0);
  h += `<div class="lvsum"><span class="up">委買 ${sb}</span><div class="pcbar"><i style="width:${sb + sa ? (sb / (sb + sa)) * 100 : 50}%"></i></div><span class="down">委賣 ${sa}</span></div>`;
  $('book').innerHTML = h;
}

// ───────────────────────── 主迴圈 ─────────────────────────
let lastRecenter = 0;
function frame() {
  const now = performance.now();
  if (dirty) {
    dirty = false;
    const m = metrics();
    renderCards(m);
    renderChain(m);
    renderDetail(m);
    if (now - lastRecenter > 3000) { lastRecenter = now; recenter(); }
  }
  // 讓閃爍效果在 700ms 後消失
  for (const x of quotes.values()) if (x.flash && now - x.flash < 800) { dirty = true; break; }
  setTimeout(() => requestAnimationFrame(frame), 200);
}

function session(): 'day' | 'night' | 'closed' {
  const t = new Date(Date.now() + 8 * 3600_000);
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  const wd = t.getUTCDay();
  if (wd >= 1 && wd <= 5 && mins >= 8 * 60 + 45 && mins < 13 * 60 + 45) return 'day';
  if ((wd >= 1 && wd <= 5 && mins >= 15 * 60) || (wd >= 2 && wd <= 6 && mins < 5 * 60)) return 'night';
  return 'closed';
}

function clock() {
  const t = new Date(Date.now() + 8 * 3600_000);
  $('clock').textContent = t.toISOString().slice(11, 19);
  const s = session();
  const day = s === 'day', night = s === 'night';
  $('session').textContent = day ? '日盤交易中' : night ? '夜盤交易中' : '休市';
  $('session').className = 'session' + (day || night ? ' open' : '');
}

// ───────────────────────── 啟動 ─────────────────────────
async function pickBackend(): Promise<void> {
  const force = new URLSearchParams(location.search).has('demo');
  if (!force) {
    const live = new LiveBackend();
    try {
      const info = await Promise.race([
        live.info(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      be = live;
      env = info.simulation ? 'sim' : 'prod';
      return;
    } catch {
      $('banner').hidden = false;
    }
  }
  be = new DemoBackend();
  env = 'demo';
}

function showMsg(html: string) {
  $('chain-body').innerHTML = `<tr><td colspan="11" class="empty msg">${html}</td></tr>`;
}

function errText(e: unknown) {
  const s = String((e as Error)?.message ?? e);
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

/** shioaji server 剛啟動、或與永豐主機連線暫時中斷（NotReady）時，會回 500；自動重試直到成功 */
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let delay = 2000;
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      console.warn(label, e);
      const notReady = /NotReady|transient|transport|503|500/i.test(String((e as Error)?.message ?? e));
      showMsg(`<b>${label}失敗，${Math.round(delay / 1000)} 秒後自動重試（第 ${n} 次）</b><br>
        ${notReady ? 'shioaji server 與永豐主機的連線尚未就緒，通常等一下就會恢復。<br>若持續失敗，請重新啟動 shioaji server（模擬環境深夜或維護時段也可能暫停服務）。<br>' : ''}
        <small>${errText(e).replace(/</g, '&lt;')}</small>`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30_000);
    }
  }
}

async function boot() {
  $('range').querySelector<HTMLSelectElement>('select')!.value = String(range);
  await pickBackend();
  const envEl = $('env');
  envEl.textContent = { sim: '模擬環境', prod: '正式環境', demo: 'DEMO 假資料' }[env];
  envEl.className = 'env ' + env;
  be.connect({ tick: onTick, bidask: onBidAsk, index: onIndex, status: onStatus });

  // 現貨指數與台指期
  const ix = await be.resolve('IX0001', 'IND').catch(() => ({ security_type: 'IND', exchange: 'TSE', code: 'IX0001' } as Contract));
  be.subscribe(ix, 'Quote').catch(() => undefined);
  fut = await retry('查詢台指期商品檔', () => be.resolve('TXFR1', 'FUT'));
  futKey = keyOf(fut);
  be.contractInfo(fut).then((info) => {
    const x = q(futKey);
    if (!fin(x.ref) && fin(info.reference) && info.reference > 0) { x.ref = info.reference; dirty = true; }
  }).catch(() => undefined);
  const [snapIx] = await be.snapshots([ix]).catch(() => []);
  if (snapIx && !idx) {
    idx = { code: 'IX0001', t: 0, close: snapIx.close, reference: snapIx.close - snapIx.change_price, open: snapIx.open,
      high: snapIx.high, low: snapIx.low, amountSum: snapIx.total_amount, raise: NaN, raiseStop: 0, fall: NaN, fallStop: 0, flat: NaN };
  }
  await loadSnapshots([fut]);
  be.subscribe(fut, 'Tick').catch(() => undefined);
  be.subscribe(fut, 'BidAsk').catch(() => undefined);

  showMsg('載入選擇權商品檔…');
  await retry('載入臺指選擇權商品檔', async () => {
    await loadExpiries();
    if (!expiries.length) throw new Error('找不到任何未到期的臺指選擇權合約（商品檔可能尚未載入完成）');
  });
  renderExpiries();
  if (cur) await selectExpiry(cur);
  select(fut, '台指期 近月');
  frame();

  // 每 15 秒以快照校正整條鏈的成交量（P/C 比與壓力支撐用全鏈資料）
  setInterval(() => { if (cur) loadSnapshots(cur.list); }, 15_000);
}

// ───────────────────────── 事件綁定 ─────────────────────────
$('expiries').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-key]');
  const e = expiries.find((x) => x.key === b?.dataset.key);
  if (e && e !== cur) selectExpiry(e);
});
$('chain-body').addEventListener('click', (ev) => {
  const td = (ev.target as HTMLElement).closest('tr')?.querySelector<HTMLElement>(
    `td.px[data-side="${(ev.target as HTMLElement).closest<HTMLElement>('td')?.dataset.side ?? 'C'}"]`);
  const code = td?.dataset.code;
  const o = cur?.list.find((x) => x.code === code);
  if (o) {
    select(o, `${o.right === 'C' ? '買權 Call' : '賣權 Put'} ${fmt(o.strike)}　${cur!.label} ${cur!.kind}`);
    // 手機上明細在報價表下方，點了之後自動捲過去
    if (compactMq.matches) setTimeout(() => document.querySelector('.detail')?.scrollIntoView({ behavior: 'smooth' }), 50);
  }
});
$('fut-btn').addEventListener('click', () => fut && select(fut, '台指期 近月'));
$('center-btn').addEventListener('click', () => recenter(true));
$('range').querySelector('select')!.addEventListener('change', (ev) => {
  range = Number((ev.target as HTMLSelectElement).value);
  LS.set('range', String(range));
  recenter(true);
});
document.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'SELECT') return;
  const i = expiries.indexOf(cur!);
  if (ev.key === 'ArrowRight' && i < expiries.length - 1) selectExpiry(expiries[i + 1]);
  if (ev.key === 'ArrowLeft' && i > 0) selectExpiry(expiries[i - 1]);
  if (ev.key === 'c' || ev.key === 'C') recenter(true);
  if (ev.key === 'f' || ev.key === 'F') fut && select(fut, '台指期 近月');
});

// 窄螢幕（手機）隱藏 IV / Delta 欄，表頭的跨欄數要跟著調整
const compactMq = window.matchMedia('(max-width: 1000px)');
function applyCompact() {
  const n = compactMq.matches ? '3' : '5';
  $('sh-c').setAttribute('colspan', n);
  $('sh-p').setAttribute('colspan', n);
}
compactMq.addEventListener('change', applyCompact);
applyCompact();

setInterval(clock, 1000);
clock();
boot().catch((e) => {
  console.error(e);
  showMsg(`啟動失敗：${errText(e).replace(/</g, '&lt;')}`);
});
