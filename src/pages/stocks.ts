// 個股頁（需求：docs/ai/requirements.md 第 1、2、3、7 輪）
//   左：自選清單（庫存置頂、可自訂多個群組、拖曳排序、電腦手機同步）＋搜尋
//   右：盤中模式（分時＋VWAP、五檔力道、內外盤、大單三級統計、逐筆明細）
//       K 線模式（日／週／月 K、MA5/10/20/60、布林、RSI、分價量表）
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { account } from '../core/account';
import { hub } from '../core/hub';
import { bollinger, regroup, rsi, sma, toDaily, volumeProfile, vwap } from '../core/indicators';
import { store } from '../core/store';
import { cls, compactMq, cssVar, esc, fin, fmt, fmtP, LS, sign, tpeToday, pointerHeld } from '../core/util';
import type { Bar, Contract, Info, Tick } from '../types';
import type { Page } from './page';

const OWNER_WL = 'stocks-watch';
const OWNER_CUR = 'stocks-current';

const TEMPLATE = `
<section class="stk">
  <aside class="wl">
    <div class="wl-search"><input id="wl-q" placeholder="輸入代碼或名稱，Enter 開啟" autocomplete="off"><div id="wl-sug" class="wl-sug" hidden></div></div>
    <div class="wl-groups"><select id="wl-group"></select>
      <button id="wl-add-g" title="新增群組">＋</button><button id="wl-ren-g" title="改名">✎</button><button id="wl-del-g" title="刪除群組">🗑</button></div>
    <div id="wl-list" class="wl-list"></div>
    <div id="wl-sync" class="wl-sync"></div>
  </aside>
  <section class="sm">
    <div id="sh" class="sh"></div>
    <div class="sm-bar">
      <div class="seg" id="mode"><button data-m="live">盤中</button><button data-m="k">K 線分析</button></div>
      <div class="seg" id="kunit"><button data-u="day">日K</button><button data-u="week">週K</button><button data-u="month">月K</button></div>
      <div class="seg tg" id="ktog"><button data-t="ma">均線</button><button data-t="bb">布林</button><button data-t="rsi">RSI</button><button data-t="vp">分價量</button></div>
      <button id="add-watch" class="addw">＋ 加入自選</button>
    </div>
    <div id="live" class="live">
      <div class="card lv-chart"><div class="ichart"><div id="ichart" class="fc-in"></div></div>
        <div class="lgd"><i class="l-px"></i>成交價　<i class="l-vwap"></i>VWAP 均價　<span class="dash">- - </span>參考價</div></div>
      <div class="lv-side">
        <div class="card"><div class="ct">五檔</div><div id="sbook" class="book"></div></div>
        <div class="card"><div class="ct">內外盤<span class="tip" title="外盤：買方主動吃賣單成交；內盤：賣方主動砸買單成交">?</span></div><div id="inout"></div></div>
        <div class="card"><div class="ct">大單統計<span class="tip" title="依單筆成交金額推估：散戶 <100萬或≤2張、中實戶 ≥100萬且≥3張、大戶 ≥500萬且≥10張、法人級 ≥2,000萬且≥50張（金額與張數都達標才算）。逐筆成交是匿名的，無法真正分辨身分；淨買＝外盤（主動買）−內盤（主動賣）">?</span></div><div id="big"></div>
          <div class="flow-head"><span>累計淨買</span><span id="flow-lgd" class="flow-lgd"></span></div>
          <div class="flowchart"><div id="flowchart" class="fc-in"></div></div></div>
      </div>
      <div class="card lv-ticks"><div class="ct">逐筆成交<label class="ct-r"><input type="checkbox" id="only-big"> 只看大單</label></div><div id="ticks" class="ticks"></div></div>
    </div>
    <div id="kview" class="kview" hidden>
      <div class="card k-card"><div class="k-wrap"><div id="kchart" class="kchart"></div><div id="vp" class="vp"></div></div>
        <div id="kinfo" class="kinfo"></div><div id="rchart" class="rchart"></div></div>
    </div>
  </section>
</section>`;

// ───────── 狀態 ─────────
let mounted = false;
let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const cleanups: (() => void)[] = [];
let code = '';
let contract: Contract | null = null;
let info: Info | null = null;
let mode: 'live' | 'k' = (LS.get('stkMode') as 'live' | 'k') ?? 'live';
let kunit: 'day' | 'week' | 'month' = (LS.get('stkUnit') as 'day' | 'week' | 'month') ?? 'day';
const tog = LS.getJSON<Record<string, boolean>>('stkTog', { ma: true, bb: false, rsi: true, vp: true });
let groupId = LS.get('stkGroup') ?? '';
let ticks: Tick[] = [];
const contracts = new Map<string, Contract>();
const minuteCache = new Map<string, { at: number; bars: Bar[]; days: number }>();
let loadSeq = 0;

// ───────── 合約與名稱 ─────────
async function contractOf(c: string): Promise<Contract> {
  const hit = contracts.get(c);
  if (hit) return hit;
  const ct = await hub.be.resolve(c, 'STK').catch(() => ({ security_type: 'STK', exchange: 'TSE', code: c } as Contract));
  contracts.set(c, ct);
  return ct;
}
const nameOf = (c: string) => account.nameOf(c);

// ───────── 自選清單 ─────────
function groups() { return store.data.groups; }
function curGroup() { return groups().find((g) => g.id === groupId) ?? groups()[0]; }
let wlSubs = new Set<string>();

async function syncWatchSubs() {
  const want = new Set([...account.state.stkPos.map((p) => p.code), ...(curGroup()?.codes ?? [])]);
  for (const c of wlSubs) if (!want.has(c)) hub.release(OWNER_WL, contracts.get(c) ?? { security_type: 'STK', exchange: 'TSE', code: c }, ['Tick']);
  const added = [...want].filter((c) => !wlSubs.has(c));
  wlSubs = want;
  const cts = await Promise.all(added.map(contractOf));
  if (!mounted) return;
  for (const ct of cts) hub.acquire(OWNER_WL, ct, ['Tick']);
  hub.loadSnapshots(cts);
}

function renderGroups() {
  const sel = document.getElementById('wl-group') as HTMLSelectElement;
  sel.innerHTML = groups().map((g) => `<option value="${g.id}">${esc(g.name)}（${g.codes.length}）</option>`).join('');
  sel.value = curGroup()?.id ?? '';
  document.getElementById('wl-sync')!.innerHTML = store.synced
    ? '✓ 自選清單電腦手機同步中' : '自選清單只存在這個瀏覽器<span class="tip" title="改用 http://localhost:5180（npm.cmd run phone）開啟即可與手機同步">?</span>';
}

function wlRow(c: string, held: boolean, draggable: boolean) {
  const x = hub.quotes.get(c);
  const pct = x ? (x.last / x.ref - 1) * 100 : NaN;
  const now = performance.now();
  const fl = x && now - x.flash < 700 ? (x.dir > 0 ? ' fu' : ' fd') : '';
  return `<div class="wr${c === code ? ' on' : ''}" data-code="${c}" ${draggable ? 'draggable="true"' : ''}>
    <div class="wn"><b>${esc(nameOf(c))}</b><small>${c}${held ? ' <em>庫存</em>' : ''}</small></div>
    <div class="wp ${cls(pct)}${fl}">${x && fin(x.last) ? fmtP(x.last) : '—'}</div>
    <div class="wc ${cls(pct)}">${fin(pct) ? sign(pct, 2) + '%' : ''}</div>
    ${draggable ? `<button class="wx" data-rm="${c}" title="移除">×</button>` : ''}</div>`;
}

function renderWatch() {
  const held = [...new Set(account.state.stkPos.map((p) => p.code))];
  const g = curGroup();
  const list = (g?.codes ?? []).filter((c) => !held.includes(c));
  document.getElementById('wl-list')!.innerHTML =
    (held.length ? `<div class="wl-h">庫存</div>${held.map((c) => wlRow(c, true, false)).join('')}` : '') +
    `<div class="wl-h">${esc(g?.name ?? '自選')}<small>拖曳可排序</small></div>` +
    (list.length ? list.map((c) => wlRow(c, false, true)).join('') : '<div class="muted wl-empty">還沒有股票，用上方搜尋或「＋ 加入自選」</div>');
}

// ───────── 搜尋 ─────────
function allNames(): [string, string][] {
  const m = { ...LS.getJSON<Record<string, string>>('names', {}), ...account.names };
  return Object.entries(m).filter(([c, n]) => /^\d{4,6}[A-Z]?$/.test(c) && n && n !== c);
}
function suggest(q: string) {
  const box = document.getElementById('wl-sug')!;
  q = q.trim();
  if (!q) { box.hidden = true; return; }
  const hits = allNames().filter(([c, n]) => c.startsWith(q.toUpperCase()) || n.includes(q)).slice(0, 8);
  const exact = /^\d{4,6}[A-Z]?$/i.test(q) && !hits.some(([c]) => c === q.toUpperCase());
  box.innerHTML = (exact ? `<div data-code="${esc(q.toUpperCase())}">開啟 <b>${esc(q.toUpperCase())}</b></div>` : '') +
    hits.map(([c, n]) => `<div data-code="${c}"><b>${esc(n)}</b> ${c}</div>`).join('');
  box.hidden = !box.innerHTML;
}

// ───────── 開啟一檔股票 ─────────
async function open(c: string) {
  c = c.trim().toUpperCase();
  if (!c || c === code) return;
  if (contract) hub.release(OWNER_CUR, contract, ['Tick', 'BidAsk']);
  code = c;
  LS.set('stkCode', c);
  if (location.hash !== `#/stocks/${c}`) history.replaceState(null, '', `#/stocks/${c}`);
  const seq = ++loadSeq;
  ticks = []; info = null; contract = null; refPx = NaN; flowTicksLen = -1; lastFlowDraw = 0;
  if (refLine && pxLine) { pxLine.removePriceLine(refLine); refLine = null; }
  dirty = true;
  const ct = await contractOf(c);
  if (seq !== loadSeq || !mounted) return;
  contract = ct;
  hub.acquire(OWNER_CUR, ct, ['Tick', 'BidAsk']);
  hub.loadSnapshots([ct]);
  hub.be.contractInfo(ct).then((i) => { if (seq === loadSeq) { info = i; account.names[c] = i.name; dirty = true; } }).catch(() => undefined);
  // 逐筆成交（大單統計）：今天沒有交易就取最近交易日
  loadMinutes(ct, 7).then((bars) => {
    if (seq !== loadSeq || !mounted) return;
    const lastDay = bars.length ? new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10) : tpeToday();
    setIntraday(bars);
    hub.be.ticksDay(ct, lastDay).then((t) => { if (seq === loadSeq) { ticks = t; dirty = true; } }).catch(() => undefined);
  });
  if (mode === 'k') loadK();
}

async function loadMinutes(ct: Contract, days: number): Promise<Bar[]> {
  const hit = minuteCache.get(ct.code);
  if (hit && hit.days >= days && Date.now() - hit.at < 5 * 60_000) return hit.bars;
  const bars = await hub.be.kbars(ct, tpeToday(-days), tpeToday()).catch(() => [] as Bar[]);
  minuteCache.set(ct.code, { at: Date.now(), bars, days });
  return bars;
}

// ───────── 盤中：分時＋VWAP ─────────
let ichart: IChartApi | null = null;
let pxLine: ISeriesApi<'Line'> | null = null;
let vwLine: ISeriesApi<'Line'> | null = null;
let ivol: ISeriesApi<'Histogram'> | null = null;
let refLine: IPriceLine | null = null;
let dayBars: Bar[] = [];
let pv = 0, vv = 0;

function chartOpts() {
  return {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11 },
    grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  } as const;
}

let refPx = NaN;                                // 參考價：分時圖價格軸以它為中心上下對稱
let axisLine: ISeriesApi<'Line'> | null = null;
let ichartRO: ResizeObserver | null = null;  // 只放空白點，撐出 09:00–13:30 的完整時間軸

/** 價格軸以參考價為中心、上下對稱，最小 ±0.5%（小波動不會被放大成劇烈起伏） */
const symmetricScale = (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
  const r = orig();
  if (!r || !fin(refPx)) return r;
  const d = Math.max(Math.abs(r.priceRange.maxValue - refPx), Math.abs(r.priceRange.minValue - refPx), refPx * 0.005);
  return { ...r, priceRange: { minValue: refPx - d * 1.04, maxValue: refPx + d * 1.04 } };
};

function initIntraday() {
  ichart = createChart(document.getElementById('ichart')!, {
    ...chartOpts(),
    // 不用 fixRightEdge：它會把右邊界綁在「最後一筆實際資料」，後面空白的時段就看不到
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0 },
    // 預設上 20%、下 10% 的留白會讓參考價偏下 → 上下留白一致，漲跌兩邊等高
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
  });
  // 圖表大小改變（含從「K 線分析」切回、原本寬度 0）→ 重新鋪滿 09:00–13:30（pitfalls #7b）
  let lastW = 0;
  ichartRO = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w > 0 && w !== lastW) { lastW = w; fitSession(); }
  });
  ichartRO.observe(document.getElementById('ichart')!);
  // 注意：visible:false 的序列不會被算進時間軸，所以用「看得見但完全透明」的線
  axisLine = ichart.addSeries(LineSeries, {
    color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  pxLine = ichart.addSeries(LineSeries, { color: '#c9d1d9', lineWidth: 2, priceLineVisible: false, autoscaleInfoProvider: symmetricScale });
  vwLine = ichart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 1, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: symmetricScale });
  ivol = ichart.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  ichart.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
}

function setIntraday(bars: Bar[]) {
  if (!pxLine) return;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const last = bars.length ? day(bars[bars.length - 1].t) : '';
  dayBars = bars.filter((b) => day(b.t) === last).map((b) => ({ ...b }));
  const vw = vwap(dayBars);
  pv = dayBars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0);
  vv = dayBars.reduce((s, b) => s + b.v, 0);
  pxLine.setData(dayBars.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
  vwLine!.setData(dayBars.map((b, i) => ({ time: b.t as UTCTimestamp, value: vw[i] })));
  ivol!.setData(dayBars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? cssVar('--up-a') : cssVar('--down-a') })));
  // 以 09:00 開盤、13:30 收盤為錨點：每分鐘一個空白點，時間軸永遠是完整交易時段
  const d0 = last ? Date.parse(last + 'T00:00:00Z') / 1000 : Date.parse(tpeToday() + 'T00:00:00Z') / 1000;
  const axis = [];
  for (let m = 9 * 60; m <= 13 * 60 + 30; m++) axis.push({ time: (d0 + m * 60) as UTCTimestamp });
  axisLine!.setData(axis);
  fAxis?.setData(axis);
  fitSession();
  fitFlow();
  flowTicksLen = -1;
}

/** 顯示範圍＝ 09:00 到 13:30（axis 的第 0 到最後一點）；等版面量好寬度再設定（pitfalls #7b） */
function fitSession() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById('ichart');
    if (!ichart || !el) return;
    ichart.resize(el.clientWidth, el.clientHeight);
    // 兩端各留幾分鐘邊距，09:00、13:30 的時間標籤才不會被切掉
    ichart.timeScale().setVisibleLogicalRange({ from: -6, to: 270 + 6 });
  }));
}

function onTick(t: Tick) {
  if (t.code !== code) return;
  ticks.push(t);
  if (ticks.length > 20000) ticks.splice(0, 5000);
  if (!pxLine) return;
  const b = Math.ceil(t.t / 60) * 60;
  let bar = dayBars[dayBars.length - 1];
  if (!bar || b > bar.t) { bar = { t: b, o: t.price, h: t.price, l: t.price, c: t.price, v: 0 }; dayBars.push(bar); }
  else if (b < bar.t) return;
  bar.h = Math.max(bar.h, t.price); bar.l = Math.min(bar.l, t.price); bar.c = t.price; bar.v += t.vol;
  pv += t.price * t.vol; vv += t.vol;
  pxLine.update({ time: b as UTCTimestamp, value: t.price });
  if (vv) vwLine!.update({ time: b as UTCTimestamp, value: pv / vv });
  ivol!.update({ time: b as UTCTimestamp, value: bar.v, color: bar.c >= bar.o ? cssVar('--up-a') : cssVar('--down-a') });
}

// ───────── K 線分析 ─────────
let kchart: IChartApi | null = null;
let rchart: IChartApi | null = null;
let candle: ISeriesApi<'Candlestick'> | null = null;
let kvol: ISeriesApi<'Histogram'> | null = null;
let maS: ISeriesApi<'Line'>[] = [];
let bbS: ISeriesApi<'Line'>[] = [];
let rsiS: ISeriesApi<'Line'> | null = null;
let kBars: Bar[] = [];
let vpBars: Bar[] = [];
const MA = [[5, '#f5b94a'], [10, '#8fb3ff'], [20, '#d17cff'], [60, '#5fd3c6']] as const;

function initK() {
  kchart = createChart(document.getElementById('kchart')!, { ...chartOpts(), timeScale: { borderVisible: false, timeVisible: false } });
  candle = kchart.addSeries(CandlestickSeries, {
    upColor: cssVar('--up'), downColor: cssVar('--down'), borderVisible: false, wickUpColor: cssVar('--up'), wickDownColor: cssVar('--down'),
  });
  kvol = kchart.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  kchart.priceScale('v').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  maS = MA.map(([, c]) => kchart!.addSeries(LineSeries, { color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
  bbS = [0, 1, 2].map((i) => kchart!.addSeries(LineSeries, {
    color: 'rgba(201,209,217,.55)', lineWidth: 1, lineStyle: i === 1 ? LineStyle.Dotted : LineStyle.Solid,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  }));
  rchart = createChart(document.getElementById('rchart')!, { ...chartOpts(), timeScale: { visible: false } });
  rsiS = rchart.addSeries(LineSeries, { color: '#d17cff', lineWidth: 1, priceLineVisible: false });
  rsiS.createPriceLine({ price: 70, color: 'rgba(240,82,79,.5)', lineStyle: LineStyle.Dashed, lineWidth: 1, title: '70' });
  rsiS.createPriceLine({ price: 30, color: 'rgba(34,176,125,.5)', lineStyle: LineStyle.Dashed, lineWidth: 1, title: '30' });
  // 主圖與 RSI 同步捲動；分價量表跟著可視範圍重算
  kchart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (r) rchart?.timeScale().setVisibleLogicalRange(r);
    renderVP();
  });
}

async function loadK() {
  if (!contract || !kchart) return;
  const seq = loadSeq;
  document.getElementById('kinfo')!.textContent = '載入 K 線…（一年的 1 分 K，第一次較久）';
  const bars = await loadMinutes(contract, kunit === 'day' ? 200 : 400);
  if (seq !== loadSeq || !mounted || !kchart) return;
  const days = toDaily(bars);
  kBars = kunit === 'day' ? days : regroup(days, kunit);
  vpBars = bars;
  const closes = kBars.map((b) => b.c);
  const T = (b: Bar) => b.t as UTCTimestamp;
  candle!.setData(kBars.map((b) => ({ time: T(b), open: b.o, high: b.h, low: b.l, close: b.c })));
  kvol!.setData(kBars.map((b) => ({ time: T(b), value: b.v, color: b.c >= b.o ? cssVar('--up-a') : cssVar('--down-a') })));
  MA.forEach(([n], i) => {
    const v = sma(closes, n);
    maS[i].setData(tog.ma ? kBars.map((b, j) => (fin(v[j]) ? { time: T(b), value: v[j] } : { time: T(b) })) : []);
  });
  const bb = bollinger(closes);
  [bb.up, bb.mid, bb.dn].forEach((arr, i) => bbS[i].setData(tog.bb ? kBars.map((b, j) => (fin(arr[j]) ? { time: T(b), value: arr[j] } : { time: T(b) })) : []));
  const r = rsi(closes);
  rsiS!.setData(kBars.map((b, j) => (fin(r[j]) ? { time: T(b), value: r[j] } : { time: T(b) })));
  document.getElementById('rchart')!.hidden = !tog.rsi;
  const n = kBars.length;
  // K 線圖剛從隱藏切成顯示時，寬度要等下一個畫面才量得到；太早設定範圍會把 K 棒擠成一團
  const fit = () => {
    const el = document.getElementById('kchart');
    if (!kchart || !el) return;
    kchart.resize(el.clientWidth, el.clientHeight);
    rchart?.resize(el.clientWidth, document.getElementById('rchart')!.clientHeight);
    kchart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (kunit === 'day' ? 90 : 60)), to: n + 2 });
  };
  requestAnimationFrame(() => requestAnimationFrame(fit));
  const lastR = r[r.length - 1];
  document.getElementById('kinfo')!.innerHTML =
    (tog.ma ? MA.map(([p, c], i) => { const v = sma(closes, p); return `<span style="color:${c}">MA${p} ${fmtP(v[v.length - 1])}</span>`; }).join('') : '') +
    (tog.bb ? `<span class="muted">布林 ${fmtP(bb.up[n - 1])} / ${fmtP(bb.dn[n - 1])}</span>` : '') +
    (tog.rsi ? `<span style="color:#d17cff">RSI14 ${fin(lastR) ? lastR.toFixed(1) : '—'}${lastR > 70 ? ' 過熱' : lastR < 30 ? ' 超賣' : ''}</span>` : '') +
    (tog.vp ? '<span class="accent">▮ 分價量（可視範圍）、◆ 成交最密集價位</span>' : '');
  renderVP();
}

/** 分價量表：統計目前可視範圍內的成交量分布，畫在 K 線右側 */
function renderVP() {
  const el = document.getElementById('vp');
  if (!el || !kchart || !candle) return;
  if (!tog.vp || !kBars.length) { el.innerHTML = ''; return; }
  const r = kchart.timeScale().getVisibleLogicalRange();
  const from = kBars[Math.max(0, Math.floor(r?.from ?? 0))]?.t ?? 0;
  const to = (kBars[Math.min(kBars.length - 1, Math.ceil(r?.to ?? kBars.length))]?.t ?? Infinity) + (kunit === 'month' ? 31 : kunit === 'week' ? 7 : 1) * 86400;
  const { rows, poc } = volumeProfile(vpBars.filter((b) => b.t >= from && b.t < to), 32);
  const mx = Math.max(1, ...rows.map((x) => x.v));
  el.innerHTML = rows.map((x) => {
    const y1 = candle!.priceToCoordinate(x.hi), y2 = candle!.priceToCoordinate(x.lo);
    if (y1 == null || y2 == null) return '';
    const isPoc = poc >= x.lo && poc < x.hi;
    return `<i class="${isPoc ? 'poc' : ''}" style="top:${y1}px;height:${Math.max(1, y2 - y1 - 1)}px;width:${(x.v / mx) * 100}%"></i>`;
  }).join('') + (fin(poc) && candle.priceToCoordinate(poc) != null ? `<b style="top:${candle.priceToCoordinate(poc)! - 8}px">◆ ${fmtP(poc)}</b>` : '');
}

// ───────── 右側資訊 ─────────
function renderHeader() {
  const el = document.getElementById('sh')!;
  const x = hub.quotes.get(code);
  const ref = fin(x?.ref ?? NaN) ? x!.ref : info?.reference ?? NaN;
  const last = x?.last ?? NaN, ch = last - ref;
  const held = account.state.stkPos.filter((p) => p.code === code);
  const pnl = held.reduce((s, p) => s + account.stockPnl(p), 0);
  const chip = (k: string, v: string, c = '') => `<span class="chip2"><em>${k}</em><b class="${c}">${v}</b></span>`;
  const amp = x ? ((x.high - x.low) / ref) * 100 : NaN;
  el.innerHTML = `<div class="sh-l"><div class="sh-n">${esc(info?.name ?? nameOf(code))} <small>${code}</small></div>
      <div class="sh-p ${cls(ch)}">${fmtP(last)}<small>${sign(ch, last < 100 ? 2 : 1)}　${fin(ch) ? sign((ch / ref) * 100, 2) + '%' : ''}</small></div></div>
    <div class="sh-chips">
      ${chip('開', fmtP(x?.open ?? NaN), cls((x?.open ?? NaN) - ref))}${chip('高', fmtP(x?.high ?? NaN), 'up')}${chip('低', fmtP(x?.low ?? NaN), 'down')}
      ${chip('參考', fmtP(ref))}${chip('漲停', fmtP(info?.limit_up ?? NaN), 'up')}${chip('跌停', fmtP(info?.limit_down ?? NaN), 'down')}
      ${chip('總量', x ? fmt(x.vol) + ' 張' : '—')}${chip('振幅', fin(amp) ? amp.toFixed(2) + '%' : '—')}
      ${held.length ? chip('我的庫存', `${held.reduce((s, p) => s + p.quantity, 0)} 張 ${sign(pnl, 0)}`, cls(pnl)) : ''}
    </div>`;
  // 分時圖的參考價虛線
  if (fin(ref) && ref !== refPx) { refPx = ref; ichart?.priceScale('right').applyOptions({ autoScale: true }); }
  if (pxLine && !refLine && fin(ref)) {
    refLine = pxLine.createPriceLine({ price: ref, color: cssVar('--muted'), lineStyle: LineStyle.Dashed, lineWidth: 1, title: '參考' });
  }
  const inGroup = curGroup()?.codes.includes(code);
  const btn = document.getElementById('add-watch')!;
  btn.textContent = inGroup ? `✓ 已在「${curGroup()!.name}」` : `＋ 加入「${curGroup()?.name ?? '自選'}」`;
  btn.classList.toggle('on', !!inGroup);
}

function renderBook() {
  const x = hub.quotes.get(code);
  const bids = x?.bids ?? [], asks = x?.asks ?? [];
  const mx = Math.max(1, ...bids.map((b) => b[1]), ...asks.map((a) => a[1]));
  let h = '';
  for (let i = 4; i >= 0; i--) { const a = asks[i]; h += `<div class="lv ask"><span class="p">${a ? fmtP(a[0]) : ''}</span><span class="v"><i style="width:${a ? (a[1] / mx) * 100 : 0}%"></i>${a ? a[1] : ''}</span></div>`; }
  for (let i = 0; i < 5; i++) { const b = bids[i]; h += `<div class="lv bid"><span class="p">${b ? fmtP(b[0]) : ''}</span><span class="v"><i style="width:${b ? (b[1] / mx) * 100 : 0}%"></i>${b ? b[1] : ''}</span></div>`; }
  const sb = bids.reduce((s, b) => s + b[1], 0), sa = asks.reduce((s, a) => s + a[1], 0);
  h += `<div class="lvsum"><span class="up">委買 ${sb}</span><div class="pcbar"><i style="width:${sb + sa ? (sb / (sb + sa)) * 100 : 50}%"></i></div><span class="down">委賣 ${sa}</span></div>`;
  document.getElementById('sbook')!.innerHTML = h;
}

/** 混合分級：金額與張數都達標才算該級（低等級因此較寬）。
 *  預設：散戶 <100萬或≤2張、中實戶 ≥100萬且≥3張、大戶 ≥500萬且≥10張、法人級 ≥2,000萬且≥50張 */
const tierOf = (amt: number, lots: number) => {
  const [a, b, c] = store.data.bigTiers;
  const [la, lb, lc] = store.data.bigLots ?? [3, 10, 50];
  return amt >= c && lots >= lc ? 3 : amt >= b && lots >= lb ? 2 : amt >= a && lots >= la ? 1 : 0;
};
const TIER = ['散戶', '中實戶', '大戶', '法人級'];
const TIER_COLOR = ['#8b95a3', '#8fb3ff', '#f5b94a', '#d17cff'];
const wan = (n: number) => (Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + '億' : Math.round(n / 1e4).toLocaleString() + '萬');

function renderFlow() {
  let outV = 0, inV = 0;
  const buy = [0, 0, 0, 0], sell = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
  for (const t of ticks) {
    const amt = t.price * t.vol * 1000;
    const k = tierOf(amt, t.vol);
    if (t.side === 1) { outV += t.vol; buy[k] += amt; } else if (t.side === 2) { inV += t.vol; sell[k] += amt; }
    cnt[k]++;
  }
  const tot = outV + inV;
  document.getElementById('inout')!.innerHTML = tot ? `<div class="brk"><span class="up">外盤 ${fmt(outV)}（${((outV / tot) * 100).toFixed(1)}%）</span>
    <span class="down">內盤 ${fmt(inV)}</span></div><div class="pcbar"><i style="width:${(outV / tot) * 100}%"></i></div>` : '<div class="muted">尚無成交</div>';
  const net = (k: number) => buy[k] - sell[k];
  document.getElementById('big')!.innerHTML = `<table class="grid bigt"><thead><tr><th></th><th class="r">主動買</th><th class="r">主動賣</th><th class="r">淨買</th></tr></thead><tbody>
    ${[3, 2, 1, 0].map((k) => `<tr><td><span class="tag t${k}">${TIER[k]}</span><small class="muted"> ${cnt[k]}筆</small></td>
      <td class="r up">${wan(buy[k])}</td><td class="r down">${wan(sell[k])}</td><td class="r b ${cls(net(k))}">${net(k) >= 0 ? '+' : ''}${wan(net(k))}</td></tr>`).join('')}
    </tbody></table>
    <div class="big-sum">大戶＋法人級淨買 <b class="${cls(net(2) + net(3))}">${net(2) + net(3) >= 0 ? '+' : ''}${wan(net(2) + net(3))}</b></div>`;
  renderFlowChart();
}

// ───────── 累計淨買圖：散戶／中實戶／大戶／法人級，橫軸 09:00–13:30 ─────────
let fchart: IChartApi | null = null;
let fLines: ISeriesApi<'Line'>[] = [];
let fAxis: ISeriesApi<'Line'> | null = null;
let fchartRO: ResizeObserver | null = null;
let lastFlowDraw = 0;
let flowTicksLen = -1;

const fmtMoney = (v: number) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4).toLocaleString() + '萬');

function initFlowChart() {
  const el = document.getElementById('flowchart')!;
  fchart = createChart(el, {
    ...chartOpts(),
    // 小圖不放 TradingView 標誌（會壓住線）；同頁的分時主圖保留標誌作為出處標示
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10, attributionLogo: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0 },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
    localization: { priceFormatter: fmtMoney },
    handleScroll: false, handleScale: false,
  });
  // 透明線撐出 09:00–13:30 時間軸（pitfalls #14）
  fAxis = fchart.addSeries(LineSeries, { color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  fLines = [0, 1, 2, 3].map((k) => fchart!.addSeries(LineSeries, {
    color: TIER_COLOR[k], lineWidth: k >= 2 ? 2 : 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  }));
  fLines[0].createPriceLine({ price: 0, color: 'rgba(139,149,163,.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, title: '' });
  let lastW = 0;
  fchartRO = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w > 0 && w !== lastW) { lastW = w; fitFlow(); }
  });
  fchartRO.observe(el);
}

function fitFlow() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById('flowchart');
    if (!fchart || !el || !el.clientWidth) return;
    fchart.resize(el.clientWidth, el.clientHeight);
    fchart.timeScale().setVisibleLogicalRange({ from: -6, to: 270 + 6 });
  }));
}

/** 每分鐘累計各層級「外盤−內盤」金額；資料量大時最多每秒重畫一次 */
function renderFlowChart() {
  if (!fchart || !fLines.length) return;
  const now = performance.now();
  if (ticks.length === flowTicksLen && now - lastFlowDraw < 5000) return;
  if (now - lastFlowDraw < 1000) return;
  lastFlowDraw = now;
  flowTicksLen = ticks.length;
  const cum = [0, 0, 0, 0];
  const series: { time: UTCTimestamp; value: number }[][] = [[], [], [], []];
  let cur = 0;
  const flush = () => { for (let k = 0; k < 4; k++) series[k].push({ time: cur as UTCTimestamp, value: cum[k] }); };
  for (const tk of ticks) {
    const b = Math.ceil(tk.t / 60) * 60;
    if (b !== cur) { if (cur) flush(); cur = b; }
    const amt = tk.price * tk.vol * 1000;
    const k = tierOf(amt, tk.vol);
    if (tk.side === 1) cum[k] += amt; else if (tk.side === 2) cum[k] -= amt;
  }
  if (cur) flush();
  for (let k = 0; k < 4; k++) fLines[k].setData(series[k]);
  document.getElementById('flow-lgd')!.innerHTML = [3, 2, 1, 0].map((k) =>
    `<span><i style="background:${TIER_COLOR[k]}"></i>${TIER[k]} <b class="${cls(cum[k])}">${cum[k] >= 0 ? '+' : ''}${fmtMoney(cum[k])}</b></span>`).join('');
}

function renderTicks() {
  const onlyBig = (document.getElementById('only-big') as HTMLInputElement | null)?.checked;
  const out: string[] = [];
  for (let i = ticks.length - 1; i >= 0 && out.length < 120; i--) {
    const t = ticks[i];
    const amt = t.price * t.vol * 1000, k = tierOf(amt, t.vol);
    if (onlyBig && k < 2) continue;
    const time = new Date(t.t * 1000).toISOString().slice(11, 19);
    out.push(`<div class="tk-r${k ? ' big' + k : ''}"><span class="tm">${time}</span>
      <span class="pr ${t.side === 1 ? 'up' : t.side === 2 ? 'down' : ''}">${fmtP(t.price)}</span>
      <span class="vl">${fmt(t.vol)}</span><span class="sd ${t.side === 1 ? 'up' : 'down'}">${t.side === 1 ? '外' : t.side === 2 ? '內' : ''}</span>
      <span class="tg">${k ? `<span class="tag t${k}">${TIER[k]}</span>` : ''}</span></div>`);
  }
  document.getElementById('ticks')!.innerHTML = out.join('') || '<div class="muted">尚無成交</div>';
}

function applyMode() {
  document.querySelectorAll<HTMLElement>('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
  document.querySelectorAll<HTMLElement>('#kunit button').forEach((b) => b.classList.toggle('on', b.dataset.u === kunit));
  document.querySelectorAll<HTMLElement>('#ktog button').forEach((b) => b.classList.toggle('on', !!tog[b.dataset.t!]));
  document.getElementById('live')!.hidden = mode !== 'live';
  document.getElementById('kview')!.hidden = mode !== 'k';
  document.getElementById('kunit')!.hidden = mode !== 'k';
  document.getElementById('ktog')!.hidden = mode !== 'k';
}

// ───────── 主迴圈 ─────────
function frame() {
  if (!mounted) return;
  if (dirty && code && !pointerHeld()) {
    dirty = false;
    renderHeader();
    renderWatch();
    if (mode === 'live') { renderBook(); renderFlow(); renderTicks(); }
  }
  timer = setTimeout(() => requestAnimationFrame(frame), 300);
}

function bind(el: HTMLElement) {
  const q = el.querySelector<HTMLInputElement>('#wl-q')!;
  q.addEventListener('input', () => suggest(q.value));
  q.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const first = el.querySelector<HTMLElement>('#wl-sug [data-code]')?.dataset.code ?? q.value;
    q.value = ''; suggest(''); open(first);
  });
  el.querySelector('#wl-sug')!.addEventListener('mousedown', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('[data-code]')?.dataset.code;
    if (c) { q.value = ''; suggest(''); open(c); }
  });
  q.addEventListener('blur', () => setTimeout(() => suggest(''), 150));

  const list = el.querySelector<HTMLElement>('#wl-list')!;
  list.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const rm = t.closest<HTMLElement>('[data-rm]')?.dataset.rm;
    if (rm) { store.update(() => { const g = curGroup(); if (g) g.codes = g.codes.filter((c) => c !== rm); }); return; }
    const c = t.closest<HTMLElement>('[data-code]')?.dataset.code;
    if (c) { open(c); if (compactMq.matches) document.querySelector('.sm')?.scrollIntoView({ behavior: 'smooth' }); }
  });
  // 拖曳排序（自訂群組內）
  let drag = '';
  list.addEventListener('dragstart', (ev) => { drag = (ev.target as HTMLElement).dataset.code ?? ''; });
  list.addEventListener('dragover', (ev) => ev.preventDefault());
  list.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const over = (ev.target as HTMLElement).closest<HTMLElement>('[draggable][data-code]')?.dataset.code;
    if (!drag || !over || drag === over) return;
    store.update(() => {
      const g = curGroup(); if (!g) return;
      const arr = g.codes.filter((c) => c !== drag);
      arr.splice(arr.indexOf(over), 0, drag);
      g.codes = arr;
    });
  });

  el.querySelector('#wl-group')!.addEventListener('change', (ev) => {
    groupId = (ev.target as HTMLSelectElement).value; LS.set('stkGroup', groupId); syncWatchSubs(); dirty = true;
  });
  el.querySelector('#wl-add-g')!.addEventListener('click', () => {
    const name = prompt('新群組名稱', '')?.trim();
    if (!name) return;
    const id = 'g' + Date.now();
    store.update((d) => d.groups.push({ id, name, codes: [] }));
    groupId = id; LS.set('stkGroup', id);
  });
  el.querySelector('#wl-ren-g')!.addEventListener('click', () => {
    const g = curGroup(); if (!g) return;
    const name = prompt('群組新名稱', g.name)?.trim();
    if (name) store.update(() => { g.name = name; });
  });
  el.querySelector('#wl-del-g')!.addEventListener('click', () => {
    const g = curGroup(); if (!g || groups().length <= 1) { alert('至少要保留一個群組'); return; }
    if (!confirm(`刪除群組「${g.name}」（${g.codes.length} 檔）？`)) return;
    store.update((d) => { d.groups = d.groups.filter((x) => x.id !== g.id); });
    groupId = groups()[0].id; LS.set('stkGroup', groupId);
  });
  el.querySelector('#add-watch')!.addEventListener('click', () => {
    store.update(() => {
      const g = curGroup(); if (!g || !code) return;
      g.codes = g.codes.includes(code) ? g.codes.filter((c) => c !== code) : [...g.codes, code];
    });
  });
  el.querySelector('#mode')!.addEventListener('click', (ev) => {
    const m = (ev.target as HTMLElement).dataset.m as 'live' | 'k' | undefined;
    if (!m || m === mode) return;
    mode = m; LS.set('stkMode', m); applyMode(); dirty = true;
    if (m === 'live') { fitSession(); fitFlow(); }
    if (m === 'k') loadK();
  });
  el.querySelector('#kunit')!.addEventListener('click', (ev) => {
    const u = (ev.target as HTMLElement).dataset.u as typeof kunit | undefined;
    if (!u) return;
    kunit = u; LS.set('stkUnit', u); applyMode(); loadK();
  });
  el.querySelector('#ktog')!.addEventListener('click', (ev) => {
    const k = (ev.target as HTMLElement).dataset.t;
    if (!k) return;
    tog[k] = !tog[k]; LS.setJSON('stkTog', tog); applyMode(); loadK();
  });
  el.querySelector('#only-big')!.addEventListener('change', () => { dirty = true; });
}

function codeFromHash() { return location.hash.replace(/^#\/?stocks\/?/, '').split(/[/?]/)[0]; }

export const stocksPage: Page = {
  id: 'stocks',
  title: '個股',
  mount(el) {
    mounted = true;
    dirty = true;
    el.innerHTML = TEMPLATE;
    // 每次進入都重新讀取模式（商品頁點小卡會先設定成 K 線模式，見 core/nav.ts）
    mode = (LS.get('stkMode') as 'live' | 'k') ?? 'live';
    bind(el);
    applyMode();
    initIntraday();
    initFlowChart();
    initK();
    account.use('stocks');
    renderGroups();
    cleanups.push(hub.on('change', () => { dirty = true; }));
    cleanups.push(hub.on('tick', onTick));
    cleanups.push(account.on(() => { dirty = true; syncWatchSubs(); }));
    cleanups.push(store.on(() => { renderGroups(); syncWatchSubs(); dirty = true; }));
    const onHash = () => { const c = codeFromHash(); if (location.hash.startsWith('#/stocks') && c) open(c); };
    window.addEventListener('hashchange', onHash);
    cleanups.push(() => window.removeEventListener('hashchange', onHash));
    const onResize = () => renderVP();
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));
    store.load();
    syncWatchSubs();
    code = '';
    open(codeFromHash() || LS.get('stkCode') || curGroup()?.codes[0] || '2330');
    frame();
  },
  unmount() {
    mounted = false;
    loadSeq++;
    clearTimeout(timer);
    cleanups.splice(0).forEach((f) => f());
    hub.releaseAll(OWNER_WL);
    hub.releaseAll(OWNER_CUR);
    account.unuse('stocks');
    wlSubs = new Set();
    contract = null; code = '';
    ichartRO?.disconnect(); ichartRO = null;
    fchartRO?.disconnect(); fchartRO = null;
    fchart?.remove(); fchart = null; fLines = []; fAxis = null; flowTicksLen = -1;
    ichart?.remove(); kchart?.remove(); rchart?.remove();
    ichart = kchart = rchart = null; pxLine = vwLine = axisLine = null; ivol = null; candle = null; kvol = null; rsiS = null;
    maS = []; bbS = []; refLine = null;
  },
};
