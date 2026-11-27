// 期權頁：臺指選擇權 T 字報價、8 項關鍵指標、右側走勢與五檔
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineStyle,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp,
} from 'lightweight-charts';
import { yearsToExpiry } from '../bs';
import { openTrade } from '../core/nav';
import { hub, keyOf } from '../core/hub';
import {
  computeMetrics, type Expiry, fair, loadTxoExpiries, type Metrics, pcrLabel, type Row, rowsOf, skewLabel,
  synthetic as synthetic0,
} from '../core/optchain';
import {
  $, avg, cls, compactMq, cssVar, esc, errText, fin, fmt, fmtP, fmtVol, isLive, LS, retry, scrollRowToCenter, session, sign, tpeToday, pointerHeld } from '../core/util';
import type { Bar, Contract, OptContract, Tick } from '../types';
import type { Page } from './page';

const OWNER = 'options';
const OWNER_SEL = 'options-detail';


let expiries: Expiry[] = [];
let cur: Expiry | null = null;
let range = Number(LS.get('range') ?? 10);
let center = NaN;                         // 目前 T 字報價的中心履約價
let visible: OptContract[] = [];
let selected: Contract | null = null;
let selectedName = '';
let dirty = true;
let mounted = false;
let frameTimer: ReturnType<typeof setTimeout> | undefined;
const cleanups: (() => void)[] = [];

const TEMPLATE = `
  <section class="cards">
    <div class="card" id="c-idx"></div>
    <div class="card" id="c-fut"></div>
    <div class="card" id="c-exp"></div>
    <div class="card" id="c-atm"></div>
    <div class="card hero" id="c-move"></div>
    <div class="card" id="c-iv"></div>
    <div class="card" id="c-pcr"></div>
    <div class="card" id="c-wall"></div>
  </section>

  <section class="bar">
    <div id="expiries" class="expiries"></div>
    <div class="tools">
      <label id="range">檔數 <select>
        <option value="6">±6</option><option value="8">±8</option><option value="10">±10</option>
        <option value="14">±14</option><option value="18">±18</option>
      </select></label>
      <button id="center-btn" title="快捷鍵 C">置中價平</button>
      <button id="fut-btn" title="快捷鍵 F">看台指期</button>
    </div>
  </section>

  <main>
    <div class="chain-wrap">
      <table class="chain">
        <thead>
          <tr class="sidehead"><th id="sh-c" colspan="5" class="up">買權 CALL</th><th></th><th id="sh-p" colspan="5" class="down">賣權 PUT</th></tr>
          <tr>
            <th>成交量</th><th>IV%</th><th>Delta</th><th>漲跌</th><th>成交</th>
            <th>履約價</th>
            <th>成交</th><th>漲跌</th><th>Delta</th><th>IV%</th><th>成交量</th>
          </tr>
        </thead>
        <tbody id="chain-body"><tr><td colspan="11" class="empty">載入中…</td></tr></tbody>
      </table>
      <div class="legend">
        <span><i class="lg band"></i>預期區間內</span>
        <span><i class="lg itm"></i>價內</span>
        <span><i class="lg wall"></i>最大量（壓力/支撐）</span>
        <span>點任一價格看走勢與五檔<span class="kbd">　←/→ 切換到期　C 置中</span></span>
      </div>
    </div>
    <aside class="detail">
      <div id="d-head"></div>
      <div id="chart" class="chart"></div>
      <div class="booktitle">五檔</div>
      <div id="book" class="book"></div>
    </aside>
  </main>
`;

// ───────────────────────── 核心計算（共用：core/optchain.ts） ─────────────────────────
const rows = (): Row[] => (cur ? rowsOf(cur) : []);
const synthetic = () => synthetic0(rows());
const metrics = (): Metrics => computeMetrics(cur);

async function loadExpiries() {
  expiries = await loadTxoExpiries();
  const saved = LS.get('expiryRoot');
  cur = expiries.find((e) => e.root === saved) ?? expiries[0] ?? null;
}

async function setVisible(next: OptContract[]) {
  const want = new Set(next.map((o) => o.code));
  for (const o of visible) if (!want.has(o.code)) hub.release(OWNER, o, ['Tick', 'BidAsk']);
  visible = next;
  for (const o of next) hub.acquire(OWNER, o, ['Tick', 'BidAsk']);
  dirty = true;
}

/** 以價平為中心挑出上下各 range 檔 */
let pendingScroll = false;   // 按「置中」後，下一次重畫要把價平列捲到表格中間
async function recenter(force = false) {
  if (!cur) return;
  if (force) { pendingScroll = true; dirty = true; }
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
  await hub.loadSnapshots(e.list);
  await recenter(true);
}

// ───────────────────────── 繪製：指標卡 ─────────────────────────
function card(id: string, title: string, main: string, sub: string, mainCls = '', tip = '') {
  const el = $(id);
  el.innerHTML = `<div class="ct">${title}${tip ? `<span class="tip" title="${tip}">?</span>` : ''}</div>
    <div class="cm ${mainCls}">${main}</div><div class="cs">${sub}</div>`;
}

function renderCards(m: Metrics) {
  // 1. 加權指數
  if (hub.idx) {
    const ch = hub.idx.close - hub.idx.reference;
    card('c-idx', '加權指數', fmt(hub.idx.close, 2),
      `<span class="${cls(ch)}">${sign(ch, 2)}　${sign((ch / hub.idx.reference) * 100, 2)}%</span>
       ${fin(hub.idx.raise) ? `<div class="breadth"><span class="up">▲${fmt(hub.idx.raise + hub.idx.raiseStop)}</span>
       <span class="flat">${fmt(hub.idx.flat)}</span><span class="down">▼${fmt(hub.idx.fall + hub.idx.fallStop)}</span></div>` : ''}`,
      cls(ch));
  }
  // 2. 台指期
  const f = hub.quotes.get(hub.futKey);
  if (f) {
    const ch = f.last - f.ref;
    const basis = hub.idx ? f.last - hub.idx.close : NaN;
    const basisHtml = session() === 'day'
      ? `基差 <b class="${cls(basis)}">${sign(basis, 1)}</b> ${fin(basis) ? (basis >= 0 ? '正價差' : '逆價差') : ''}`
      : `較現貨收盤 <b class="${cls(basis)}">${sign(basis, 0)}</b>`;
    card('c-fut', hub.futName, fmt(f.last),
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
  const skLbl = skewLabel(m.skew);
  card('c-iv', '價平 IV', ivTxt, `偏斜 <b>${skTxt}</b> ${skLbl}`, '',
    '價平隱含波動率：選擇權貴或便宜的溫度計。偏斜 = 25Δ Put IV − 25Δ Call IV，越大代表市場越願意花錢買下跌保護。');
  // 7. P/C
  const pcLbl = pcrLabel(m.pcr);
  const cw = m.callVol + m.putVol ? (m.callVol / (m.callVol + m.putVol)) * 100 : 50;
  card('c-pcr', 'P/C 成交量比', fin(m.pcr) ? m.pcr.toFixed(2) : '—',
    `${pcLbl}<div class="pcbar"><i style="width:${cw}%"></i></div>
     <div class="pcl"><span class="up">C ${fmtVol(m.callVol)}</span><span class="down">P ${fmtVol(m.putVol)}</span></div>`,
    '', '全部履約價 Put 總成交量 ÷ Call 總成交量（本到期別、今日）。');
  // 8. 壓力 / 支撐
  const cv = m.maxCall ? hub.quotes.get(m.maxCall.c!.code)?.vol ?? 0 : 0;
  const pv = m.maxPut ? hub.quotes.get(m.maxPut.p!.code)?.vol ?? 0 : 0;
  card('c-wall', '量能壓力 / 支撐',
    `<div class="op-wall"><small>壓</small><span class="up">${m.maxCall ? fmt(m.maxCall.k) : '—'}</span><em>${fmtVol(cv)}</em></div>
     <div class="op-wall"><small>撐</small><span class="down">${m.maxPut ? fmt(m.maxPut.k) : '—'}</span><em>${fmtVol(pv)}</em></div>`,
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
  const maxV = Math.max(1, ...rs.flatMap((r) => [r.c, r.p].map((o) => (o ? hub.quotes.get(o.code)?.vol ?? 0 : 0))));
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
      const x = hub.quotes.get(o.code);
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
        `<td class="px ${cls(ch)}${fl}${sel === o.code ? ' sel' : ''}" data-code="${o.code}">${right === 'P' ? '' : goBtn(o.code)}${fmtP(last)}${right === 'P' ? goBtn(o.code) : ''}</td>`,
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

/** 價格旁的「⚡」：帶這個選擇權到下單頁（模擬），滑鼠移到該列才顯示 */
const goBtn = (code: string) => `<button class="op-go" data-trade="${code}" title="到下單頁（模擬）">⚡</button>`;

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
  if (selected) hub.release(OWNER_SEL, selected, ['Tick', 'BidAsk']);
  selected = c; selectedName = name; lastBar = null;
  hub.acquire(OWNER_SEL, c, ['Tick', 'BidAsk']);
  ensureChart();
  candle!.setData([]); volS!.setData([]);
  dirty = true;
  try {
    const bars = await hub.be.kbars(c, tpeToday(-6), tpeToday());
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
    const r = hub.quotes.get(keyOf(c))?.ref;
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
  const x = hub.quotes.get(k);
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
  if (dirty && !pointerHeld()) {
    dirty = false;
    const m = metrics();
    renderCards(m);
    renderChain(m);
    if (pendingScroll) {
      pendingScroll = false;
      const wrap = document.querySelector('.chain-wrap');
      scrollRowToCenter(wrap, wrap?.querySelector('tr.atm') ?? wrap?.querySelector('tr.fline') ?? null);
    }
    renderDetail(m);
    if (now - lastRecenter > 3000) { lastRecenter = now; recenter(); }
  }
  // 讓閃爍效果在 700ms 後消失
  for (const x of hub.quotes.values()) if (x.flash && now - x.flash < 800) { dirty = true; break; }
  if (mounted) frameTimer = setTimeout(() => requestAnimationFrame(frame), 200);
}

function showMsg(html: string) {
  const el = document.getElementById('chain-body');
  if (el) el.innerHTML = `<tr><td colspan="11" class="empty msg">${html}</td></tr>`;
}

/** 選擇權到期日過 13:30 自動移除並切換（pitfalls #1） */
async function rollExpiries() {
  if (!cur || isLive(cur.date)) return;
  await loadExpiries();
  renderExpiries();
  if (cur) await selectExpiry(cur);
}

function applyCompact() {
  const n = compactMq.matches ? '3' : '5';
  $('sh-c')?.setAttribute('colspan', n);
  $('sh-p')?.setAttribute('colspan', n);
  dirty = true;
}

function onKey(ev: KeyboardEvent) {
  const tag = (ev.target as HTMLElement).tagName;
  if (tag === 'SELECT' || tag === 'INPUT') return;
  const i = expiries.indexOf(cur!);
  if (ev.key === 'ArrowRight' && i < expiries.length - 1) selectExpiry(expiries[i + 1]);
  if (ev.key === 'ArrowLeft' && i > 0) selectExpiry(expiries[i - 1]);
  if (ev.key === 'c' || ev.key === 'C') recenter(true);
  if ((ev.key === 'f' || ev.key === 'F') && hub.fut) select(hub.fut, hub.futName);
}

function bind() {
  $('range').querySelector<HTMLSelectElement>('select')!.value = String(range);
  $('fut-btn').textContent = `看${hub.futName.replace(' ', '')}`;
  $('expiries').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-key]');
    const e = expiries.find((x) => x.key === b?.dataset.key);
    if (e && e !== cur) selectExpiry(e);
  });
  $('chain-body').addEventListener('click', (ev) => {
    const go = (ev.target as HTMLElement).closest<HTMLElement>('[data-trade]')?.dataset.trade;
    if (go) { const o = cur?.list.find((x) => x.code === go); if (o) openTrade(o); return; }
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
  $('fut-btn').addEventListener('click', () => hub.fut && select(hub.fut, hub.futName));
  $('center-btn').addEventListener('click', () => recenter(true));
  $('range').querySelector('select')!.addEventListener('change', (ev) => {
    range = Number((ev.target as HTMLSelectElement).value);
    LS.set('range', String(range));
    recenter(true);
  });
  document.addEventListener('keydown', onKey);
  compactMq.addEventListener('change', applyCompact);
  cleanups.push(() => document.removeEventListener('keydown', onKey));
  cleanups.push(() => compactMq.removeEventListener('change', applyCompact));
  cleanups.push(hub.on('change', () => { dirty = true; }));
  cleanups.push(hub.on('tick', (t: Tick) => { if (selected && keyOf(selected) === t.code) chartTick(t); }));
  cleanups.push(hub.on('fut', ({ next, prev }) => {
    $('fut-btn').textContent = `看${hub.futName.replace(' ', '')}`;
    if (selected && prev && keyOf(selected) === keyOf(prev)) select(next, hub.futName);
  }));
  applyCompact();
}

export const optionsPage: Page = {
  id: 'options',
  title: '期權',
  async mount(el) {
    mounted = true;
    dirty = true;
    el.innerHTML = TEMPLATE;
    bind();
    frame();
    const timers = [
      setInterval(() => { if (cur) hub.loadSnapshots(cur.list); }, 15_000), // 全鏈成交量校正（P/C 比、壓力支撐）
      setInterval(rollExpiries, 60_000),
    ];
    cleanups.push(() => timers.forEach(clearInterval));
    try {
      if (!expiries.length) {
        showMsg('載入選擇權商品檔…');
        await retry('載入臺指選擇權商品檔', async () => {
          await loadExpiries();
          if (!expiries.length) throw new Error('找不到任何未到期的臺指選擇權合約（商品檔可能尚未載入完成）');
        }, showMsg);
      } else {
        await rollExpiries();
      }
      if (!mounted) return;
      renderExpiries();
      if (cur) await selectExpiry(cur);
      const sel = selected && mounted ? selected : hub.fut;
      if (sel && mounted) select(sel, selected ? selectedName : hub.futName);
    } catch (e) {
      showMsg(`啟動失敗：${esc(errText(e))}`);
    }
  },
  unmount() {
    mounted = false;
    clearTimeout(frameTimer);
    cleanups.splice(0).forEach((f) => f());
    hub.releaseAll(OWNER);
    hub.releaseAll(OWNER_SEL);
    visible = [];
    center = NaN;
    chart?.remove();
    chart = null; candle = null; volS = null; refLine = null; lastBar = null;
  },
};
