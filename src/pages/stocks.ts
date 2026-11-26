// 分析頁（原「個股」，id 仍為 stocks；需求：docs/ai/requirements.md 第 1、2、3、7、9 輪）
//   左：期權預設欄（台指期／微台近月、最近週選／月選點開選履約價）＋自選清單（庫存置頂、多群組、拖曳排序、電腦手機同步）＋搜尋
//   右：盤中模式（分時＋VWAP、五檔力道、內外盤、大單四級統計、逐筆明細）
//       K線模式（分／日／週／月 K、MA、布林、RSI、分價量表）、技術分析（1 主 2 副）
//   個股、期貨、選擇權共用同一套畫面；期貨／選擇權的時間軸依日盤／夜盤（core/session.ts）
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { account } from '../core/account';
import { hub } from '../core/hub';
import { bollinger, regroup, rsi, sma, toDaily, volumeProfile, vwap } from '../core/indicators';
import { store } from '../core/store';
import { cls, compactMq, cssVar, esc, fin, fmt, fmtP, isLive, LS, session, sign, tpeToday, pointerHeld } from '../core/util';
import { dayStart, dstr, isDayBar, isDeriv, sessionDay, shiftWeekday } from '../core/session';
import { derivName, known } from '../core/nav';
import { loadTxoExpiries, rowsOf, synthetic, type Expiry } from '../core/optchain';
import type { Bar, Contract, Info, Tick } from '../types';
import type { Page } from './page';
import { applyTick, buildBars, INTERVALS, isMinute, labelOf, type Interval } from '../core/bars';
import { TAView } from '../ui/taview';
import { limitZoom, resetZoom } from '../ui/zoom';

const OWNER_WL = 'stocks-watch';
const OWNER_CUR = 'stocks-current';
const OWNER_EXP = 'stocks-strikes';

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
      <div class="seg" id="mode"><button data-m="live">盤中</button><button data-m="k">K線</button><button data-m="ta">技術分析</button></div>
      <button id="ta-gear" class="ta-gear" title="技術指標設定" hidden>⚙</button>
      <div class="seg" id="kunit"></div>
      <div class="seg tg" id="ktog"><button data-t="ma">均線</button><button data-t="bb">布林</button><button data-t="rsi">RSI</button><button data-t="vp">分價量</button></div>
      <button id="add-watch" class="addw">＋ 加入自選</button>
    </div>
    <div id="live" class="stk-live">
      <div class="card lv-chart"><div class="ichart"><div id="ichart" class="fc-in"></div></div>
        <div class="lgd"><button id="izoom-reset" class="zoom-reset" title="回到完整交易時段">⟲ 重置</button><div class="seg stk-sess" id="isess" hidden><button data-s="day">日盤</button><button data-s="full">全時</button></div><span id="irange" class="muted stk-irange"></span><i class="l-px"></i>成交價（右軸）　<i class="l-ixo"></i><span id="ilg-ov">加權（左軸）</span>　<i class="l-vwap"></i>VWAP 均價　<span class="dash">- - </span>參考價</div></div>
      <div class="lv-side">
        <div class="card"><div class="ct">五檔</div><div id="sbook" class="book"></div></div>
        <div class="card"><div class="ct">內外盤<span class="tip" title="外盤：買方主動吃賣單成交；內盤：賣方主動砸買單成交">?</span></div><div id="inout"></div></div>
        <div class="card"><div class="ct">大單統計<span class="tip" id="big-tip">?</span></div><div id="big"></div>
          <div class="flow-head"><span>累計淨買</span><span id="flow-lgd" class="flow-lgd"></span></div>
          <div class="flowchart"><div id="flowchart" class="fc-in"></div></div></div>
      </div>
      <div class="card lv-ticks"><div class="ct">逐筆成交<label class="ct-r"><input type="checkbox" id="only-big"> 只看大單</label></div><div id="ticks" class="ticks"></div></div>
    </div>
    <div id="taview" class="card stk-ta" hidden></div>
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
type Mode = 'live' | 'k' | 'ta';
let mode: Mode = (LS.get('stkMode') as Mode) ?? 'live';
let kunit: Interval = LS.get('stkUnit') ?? 'day';
if (kunit === 'adj') kunit = 'day'; // 還原日K已移除（2026-11-27）
let taView: TAView | null = null;
const tog = LS.getJSON<Record<string, boolean>>('stkTog', { ma: true, bb: false, rsi: true, vp: true });
let groupId = LS.get('stkGroup') ?? '';
let ticks: Tick[] = [];
const contracts = new Map<string, Contract>();
const minuteCache = new Map<string, { at: number; bars: Bar[]; days: number }>();
let loadSeq = 0;
let deriv = false;                 // 目前商品是期貨或選擇權

// ───────── 合約與名稱 ─────────
/** 代碼猜商品類別：數字開頭＝股票、三碼＋月份碼＋年＝期貨（TXFL6）、其餘＝選擇權 */
const guessType = (c: string) => (/^\d/.test(c) ? 'STK' : /^[A-Z]{3}[A-L]\d$/.test(c) ? 'FUT' : 'OPT') as Contract['security_type'];
async function contractOf(c: string): Promise<Contract> {
  const hit = contracts.get(c) ?? known.get(c);
  if (hit) { contracts.set(c, hit); return hit; }
  const sec = guessType(c);
  const ct = await hub.be.resolve(c, sec).catch(() => ({ security_type: sec, exchange: sec === 'STK' ? 'TSE' : 'TAIFEX', code: c } as Contract));
  contracts.set(c, ct);
  return ct;
}
const derivNames = new Map<string, string>();
function nameOf(c: string) {
  if (guessType(c) === 'STK') return account.nameOf(c);
  const ct = contracts.get(c) ?? known.get(c);
  return derivNames.get(c) ?? (ct && derivName(ct)) ?? c;
}

// ───────── 自選清單 ─────────
function groups() { return store.data.groups; }
function curGroup() { return groups().find((g) => g.id === groupId) ?? groups()[0]; }
/** 內建群組「期權」：選單選到它才顯示台指期／微台近月與最近週選／月選（不能改名、刪除、加入個股） */
const OPT_G = '__opt';
const isOptG = () => groupId === OPT_G;
let wlSubs = new Set<string>();

async function syncWatchSubs() {
  const want = new Set(isOptG() ? [] : [...account.state.stkPos.map((p) => p.code), ...(curGroup()?.codes ?? [])]);
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
  sel.innerHTML = `<option value="${OPT_G}">期權（預設）</option>` +
    groups().map((g) => `<option value="${g.id}">${esc(g.name)}（${g.codes.length}）</option>`).join('');
  sel.value = isOptG() ? OPT_G : curGroup()?.id ?? '';
  for (const id of ['wl-ren-g', 'wl-del-g']) (document.getElementById(id) as HTMLButtonElement).disabled = isOptG();
  document.getElementById('wl-sync')!.innerHTML = store.synced
    ? '✓ 自選清單電腦手機同步中' : '自選清單只存在這個瀏覽器<span class="tip" title="改用 http://localhost:5180（npm.cmd run phone）開啟即可與手機同步">?</span>';
}

function wlRow(c: string, held: boolean, draggable: boolean, name = nameOf(c)) {
  const x = hub.quotes.get(c);
  const pct = x ? (x.last / x.ref - 1) * 100 : NaN;
  const now = performance.now();
  const fl = x && now - x.flash < 700 ? (x.dir > 0 ? ' fu' : ' fd') : '';
  return `<div class="wr${c === code ? ' on' : ''}" data-code="${c}" ${draggable ? 'draggable="true"' : ''}>
    <div class="wn"><b>${esc(name)}</b><small>${c}${held ? ' <em>庫存</em>' : ''}</small></div>
    <div class="wp ${cls(pct)}${fl}">${x && fin(x.last) ? fmtP(x.last) : '—'}</div>
    <div class="wc ${cls(pct)}">${fin(pct) ? sign(pct, 2) + '%' : ''}</div>
    ${draggable ? `<button class="wx" data-rm="${c}" title="移除">×</button>` : ''}</div>`;
}

// ───────── 期權預設欄：台指期／微台近月、最近週選／月選（點開選履約價） ─────────
let tmfNear: Contract | null = null;
let optExp: Expiry[] = [];                 // [最近週選, 最近月選]
const expOpen = new Set<string>(LS.getJSON<string[]>('stkExpOpen', []));
const expCenter = new Map<string, number>(); // 展開中的到期：目前列出的中心履約價
const STRIKES_EACH = 6;                       // 價平上下各幾檔

async function loadDerivDefaults() {
  const [tmf, exps] = await Promise.all([
    hub.be.futuresList('TMF').catch(() => []),
    loadTxoExpiries().catch(() => [] as Expiry[]),
  ]);
  if (!mounted) return;
  const near = tmf.filter((f) => isLive(f.delivery_date)).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date))[0];
  if (tmfNear && tmfNear.code !== near?.code) hub.release(OWNER_EXP, tmfNear, ['Tick']);
  if (near) { tmfNear = near; known.set(near.code, near); }
  const wk = exps.find((e) => e.root !== 'TXO'), mo = exps.find((e) => e.root === 'TXO');
  optExp = [wk, mo].filter((e): e is Expiry => !!e);
  for (const e of optExp) for (const o of e.list) known.set(o.code, o);
  syncOptSubs();
}
/** 期權群組的訂閱：選到「期權」才訂閱微台近月與展開中的履約價，切走就全部退訂 */
function syncOptSubs() {
  if (!isOptG()) { hub.releaseAll(OWNER_EXP); expCenter.clear(); dirty = true; return; }
  if (tmfNear) { hub.acquire(OWNER_EXP, tmfNear, ['Tick']); hub.loadSnapshots([tmfNear]); }
  for (const e of optExp) if (expOpen.has(expId(e))) centerStrikes(e);
  dirty = true;
}
const expId = (e: Expiry) => (e.root === 'TXO' ? 'mo' : 'wk');
function stepOf(e: Expiry) { const r = rowsOf(e); return r.length > 1 ? r[1].k - r[0].k : 50; }
function atmOf(e: Expiry) {
  const F = synthetic(rowsOf(e));
  return fin(F) ? F : hub.quotes.get(hub.futKey)?.last ?? hub.idx?.close ?? NaN;
}
function shownRows(e: Expiry) {
  const c = expCenter.get(e.key);
  if (c == null) return [];
  const rows = rowsOf(e);
  const i = rows.findIndex((r) => r.k >= c);
  const at = i < 0 ? rows.length - 1 : i;
  return rows.slice(Math.max(0, at - STRIKES_EACH), at + STRIKES_EACH + 1);
}
/** 展開時以價平為中心列出履約價並訂閱；價平移動超過 3 檔再重新置中 */
function centerStrikes(e: Expiry) {
  const F = atmOf(e);
  if (!fin(F)) return;
  const step = stepOf(e);
  const old = expCenter.get(e.key);
  if (old != null && Math.abs(F - old) < step * 3) return;
  for (const r of shownRows(e)) for (const o of [r.c, r.p]) if (o) hub.release(OWNER_EXP, o, ['Tick']);
  expCenter.set(e.key, Math.round(F / step) * step);
  const cts = shownRows(e).flatMap((r) => [r.c, r.p]).filter((o): o is NonNullable<typeof o> => !!o);
  for (const o of cts) hub.acquire(OWNER_EXP, o, ['Tick']);
  hub.loadSnapshots(cts);
}
function toggleExp(id: string) {
  const e = optExp.find((x) => expId(x) === id);
  if (!e) return;
  if (expOpen.has(id)) {
    expOpen.delete(id);
    for (const r of shownRows(e)) for (const o of [r.c, r.p]) if (o) hub.release(OWNER_EXP, o, ['Tick']);
    expCenter.delete(e.key);
  } else { expOpen.add(id); centerStrikes(e); }
  LS.setJSON('stkExpOpen', [...expOpen]);
  dirty = true;
}

function derivSection() {
  const rows: string[] = [];
  if (hub.fut) rows.push(wlRow(hub.futKey, false, false, hub.futName));
  if (tmfNear) rows.push(wlRow(tmfNear.code, false, false, derivName(tmfNear) ?? '微台 近月'));
  for (const e of optExp) {
    const id = expId(e), open = expOpen.has(id);
    if (open) centerStrikes(e);
    rows.push(`<div class="wr wr-exp${open ? ' open' : ''}" data-exp="${id}"><div class="wn"><b>${open ? '▾' : '▸'} 選擇權 ${e.root === 'TXO' ? '月選' : '週選'} ${e.label}</b>
      <small>${e.kind}結算・點開選履約價</small></div></div>`);
    if (!open) continue;
    const F = atmOf(e);
    const cell = (o: (typeof e.list)[number] | undefined) => {
      if (!o) return '<span></span>';
      const x = hub.quotes.get(o.code);
      const ch = x ? x.last - x.ref : NaN;
      return `<span class="stk-oc${o.code === code ? ' on' : ''} ${cls(ch)}" data-code="${o.code}" title="${esc(derivName(o) ?? o.code)}">${x && fin(x.last) ? fmtP(x.last) : '—'}</span>`;
    };
    rows.push(`<div class="stk-strikes"><div class="stk-sh"><span>買權</span><span>履約價</span><span>賣權</span></div>${shownRows(e).map((r) =>
      `<div class="stk-sr${fin(F) && Math.abs(r.k - F) < stepOf(e) / 2 ? ' atm' : ''}">${cell(r.c)}<b>${r.k}</b>${cell(r.p)}</div>`).join('')}</div>`);
  }
  if (!rows.length) return '<div class="muted wl-empty">期權商品載入中…</div>';
  const nFut = (hub.fut ? 1 : 0) + (tmfNear ? 1 : 0);
  return `<div class="wl-h">期貨近月</div>${rows.slice(0, nFut).join('')}` +
    `<div class="wl-h">選擇權近期結算<small>點開選履約價</small></div>${rows.slice(nFut).join('')}`;
}

function renderWatch() {
  const held = [...new Set(account.state.stkPos.map((p) => p.code))];
  const g = curGroup();
  const list = (g?.codes ?? []).filter((c) => !held.includes(c));
  if (isOptG()) { document.getElementById('wl-list')!.innerHTML = derivSection(); return; }
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
  const wasDeriv = deriv;
  deriv = isDeriv(ct);
  if (deriv !== wasDeriv) { manualSess = false; sess = autoSess(); }
  applyKind();
  hub.acquire(OWNER_CUR, ct, ['Tick', 'BidAsk']);
  hub.loadSnapshots([ct]);
  hub.be.contractInfo(ct).then((i) => {
    if (seq !== loadSeq) return;
    info = i;
    if (deriv) { if (!derivName(ct) && i.name && i.name !== c) derivNames.set(c, i.name); }
    else account.names[c] = i.name;
    dirty = true;
  }).catch(() => undefined);
  loadLive();
  if (mode === 'k') loadK();
  if (mode === 'ta') loadTA();
}

/** 盤中走勢＋逐筆成交（大單統計）：今天沒有交易就取最近交易日 */
function loadLive() {
  const ct = contract, seq = loadSeq;
  if (!ct) return;
  loadMinutes(ct, 7, true).then((bars) => {
    if (seq !== loadSeq || !mounted) return;
    const day = setIntraday(bars);
    ticks = [];
    flowTicksLen = -1; dirty = true;
    hub.be.ticksDay(ct, day).then((t) => {
      if (seq !== loadSeq) return;
      ticks = deriv ? t.filter((x) => inRange(Math.ceil(x.t / 60) * 60)) : t;
      flowTicksLen = -1; dirty = true;
    }).catch(() => undefined);
  });
}

async function loadMinutes(ct: Contract, days: number, fresh = false): Promise<Bar[]> {
  const hit = minuteCache.get(ct.code);
  if (hit && hit.days >= days && Date.now() - hit.at < (fresh ? 30_000 : 5 * 60_000)) return hit.bars;
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
let ichartRO: ResizeObserver | null = null;
let ixOverlay: ISeriesApi<'Line'> | null = null;    // 疊加線（左軸）：個股／期貨疊加權指數，選擇權疊台指期近月
let ixLastT = 0, ixDay = '';
let ovFut = false;                                  // 疊加線是台指期（選擇權）而非加權
let rangeLo = 0, rangeHi = 0, axisN = 271;          // 目前時間軸（每分鐘一個空白點）的起訖與點數
let irange = { from: -6, to: 270 + 6 };             // 完整時段的可視範圍（兩端留幾分鐘邊距）
const inRange = (b: number) => b >= rangeLo && b <= rangeHi;

// 期貨／選擇權：日盤 08:45–13:45；全時＝前一交易日 15:00 → 當日 13:45（同總覽）
type Sess = 'day' | 'full';
const autoSess = (): Sess => (session() === 'night' ? 'full' : 'day');
let sess: Sess = autoSess();
let manualSess = false;

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
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0, minBarSpacing: 0.05 },
    // 預設上 20%、下 10% 的留白會讓參考價偏下 → 上下留白一致，漲跌兩邊等高
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
    // 左側：加權指數（與個股各自以參考價置中，參考價落在同一水平線，強弱一眼可比）
    leftPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
  });
  // 圖表大小改變（含從「K 線分析」切回、原本寬度 0）→ 重新鋪滿 09:00–13:30（pitfalls #7b）
  let lastW = 0;
  ichartRO = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w > 0 && w !== lastW) { lastW = w; fitSession(); }
  });
  ichartRO.observe(document.getElementById('ichart')!);
  limitZoom(ichart, () => irange);
  document.getElementById('izoom-reset')!.addEventListener('click', () => fitSession());
  // 注意：visible:false 的序列不會被算進時間軸，所以用「看得見但完全透明」的線
  axisLine = ichart.addSeries(LineSeries, {
    color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  pxLine = ichart.addSeries(LineSeries, { color: '#c9d1d9', lineWidth: 2, priceLineVisible: false, autoscaleInfoProvider: symmetricScale });
  ixOverlay = ichart.addSeries(LineSeries, {
    priceScaleId: 'left', color: 'rgba(143,179,255,.75)', lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
    crosshairMarkerVisible: false, title: '加權',
    autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
      const r = orig();
      const ref = ovFut ? hub.quotes.get(hub.futKey)?.ref ?? NaN : hub.idx?.reference ?? NaN;
      if (!r || !fin(ref)) return r;
      const d = Math.max(Math.abs(r.priceRange.maxValue - ref), Math.abs(r.priceRange.minValue - ref), ref * 0.005);
      return { ...r, priceRange: { minValue: ref - d * 1.04, maxValue: ref + d * 1.04 } };
    },
  });
  vwLine = ichart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 1, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: symmetricScale });
  ivol = ichart.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  ichart.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
}

/** 依商品與時段挑出要畫的 1 分 K、建立固定時間軸；回傳交易日（查逐筆成交用） */
function setIntraday(bars: Bar[]): string {
  if (!pxLine) return tpeToday();
  const axis: number[] = [];
  let sel: Bar[], day: string, ixDate: string, label = '';
  if (!deriv) {
    day = bars.length ? dstr(bars[bars.length - 1].t) : tpeToday();
    sel = bars.filter((b) => dstr(b.t) === day);
    // 以 09:00 開盤、13:30 收盤為錨點：每分鐘一個空白點，時間軸永遠是完整交易時段
    for (let m = 9 * 60; m <= 13 * 60 + 30; m++) axis.push(dayStart(day) + m * 60);
    ixDate = day;
  } else if (sess === 'full') {
    day = bars.length ? sessionDay(bars[bars.length - 1].t) : sessionDay(Math.floor(Date.now() / 1000) + 8 * 3600);
    const N = shiftWeekday(day, -1);
    sel = bars.filter((b) => sessionDay(b.t) === day);
    for (let m = 15 * 60 + 1; m <= 29 * 60; m++) axis.push(dayStart(N) + m * 60);    // 前一交易日 15:01 → 隔日 05:00
    for (let m = 8 * 60 + 46; m <= 13 * 60 + 45; m++) axis.push(dayStart(day) + m * 60); // 當日 08:46 → 13:45
    label = `${+N.slice(5, 7)}/${+N.slice(8)} 15:00 → ${+day.slice(5, 7)}/${+day.slice(8)} 13:45`;
    ixDate = day;
  } else {
    const days = bars.filter((b) => isDayBar(b.t));
    day = days.length ? dstr(days[days.length - 1].t) : tpeToday();
    sel = days.filter((b) => dstr(b.t) === day);
    for (let m = 8 * 60 + 46; m <= 13 * 60 + 45; m++) axis.push(dayStart(day) + m * 60);
    label = `${+day.slice(5, 7)}/${+day.slice(8)} 08:45 → 13:45`;
    ixDate = day;
  }
  rangeLo = axis[0]; rangeHi = axis[axis.length - 1]; axisN = axis.length;
  irange = { from: -6, to: axisN - 1 + 6 };
  dayBars = sel.map((b) => ({ ...b }));
  const vw = vwap(dayBars);
  pv = dayBars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0);
  vv = dayBars.reduce((s, b) => s + b.v, 0);
  pxLine.setData(dayBars.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
  vwLine!.setData(dayBars.map((b, i) => ({ time: b.t as UTCTimestamp, value: vw[i] })));
  ivol!.setData(dayBars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? cssVar('--up-a') : cssVar('--down-a') })));
  const ax = axis.map((t) => ({ time: t as UTCTimestamp }));
  axisLine!.setData(ax);
  fAxis?.setData(ax);
  document.getElementById('irange')!.textContent = label;
  document.querySelectorAll<HTMLElement>('#isess button').forEach((b) => b.classList.toggle('on', b.dataset.s === sess));
  loadOverlay(ixDate);
  fitSession();
  fitFlow();
  flowTicksLen = -1;
  return day;
}

/** 疊加線（左軸）：個股／期貨＝加權指數同一天 09:01–13:30；選擇權＝台指期近月同一時段 */
async function loadOverlay(date: string) {
  const key = `${ovFut ? 'F' : 'I'}${date}${rangeLo}`;
  ixDay = key; ixLastT = 0;
  if (ovFut && !hub.fut) { ixOverlay?.setData([]); return; }
  const src = ovFut ? hub.fut! : hub.ixContract;
  const from = ovFut ? dstr(rangeLo) : date;
  const bars = await hub.be.kbars(src, from, date).catch(() => [] as Bar[]);
  if (!ixOverlay || ixDay !== key) return;
  const day = bars.filter((b) => (ovFut ? inRange(b.t) : dstr(b.t) === date));
  ixOverlay.setData(day.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
  ixLastT = day.length ? day[day.length - 1].t : 0;
}

function onIndex(i: import('../types').IndexQuote) {
  if (ovFut || i.code !== 'IX0001' || !ixOverlay || !i.t || !fin(i.close)) return;
  const b = Math.ceil(i.t / 60) * 60;
  const m = (b % 86400) / 60;
  if (dstr(b) !== ixDay.slice(1, 11) || m < 9 * 60 || m > 13 * 60 + 30 || b < ixLastT || !inRange(b)) return;
  ixLastT = b;
  ixOverlay.update({ time: b as UTCTimestamp, value: i.close });
}
function onFutOverlay(t: Tick) {
  if (!ovFut || t.code !== hub.futKey || !ixOverlay || t.simtrade) return;
  const b = Math.ceil(t.t / 60) * 60;
  if (!inRange(b) || b < ixLastT) return;
  ixLastT = b;
  ixOverlay.update({ time: b as UTCTimestamp, value: t.price });
}

/** 依商品類別（個股／期貨／選擇權）調整畫面上的文字與按鈕 */
function applyKind() {
  ovFut = contract?.security_type === 'OPT';
  document.getElementById('isess')!.hidden = !deriv;
  document.getElementById('irange')!.hidden = !deriv;
  document.getElementById('ilg-ov')!.textContent = ovFut ? '台指期（左軸）' : '加權（左軸）';
  ixOverlay?.applyOptions({ title: ovFut ? '台指' : '加權' });
  const [a, b, c] = lotTiers();
  document.getElementById('big-tip')!.title = deriv
    ? `依單筆成交口數推估：散戶 <${a}口、中實戶 ≥${a}口、大戶 ≥${b}口、法人級 ≥${c}口。逐筆成交是匿名的，無法真正分辨身分；淨買＝外盤（主動買）−內盤（主動賣），單位：口`
    : '依單筆成交金額推估：散戶 <100萬或≤2張、中實戶 ≥100萬且≥3張、大戶 ≥500萬且≥10張、法人級 ≥2,000萬且≥50張（金額與張數都達標才算）。逐筆成交是匿名的，無法真正分辨身分；淨買＝外盤（主動買）−內盤（主動賣）';
}

/** 顯示範圍＝ 09:00 到 13:30（axis 的第 0 到最後一點）；等版面量好寬度再設定（pitfalls #7b） */
function fitSession() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById('ichart');
    if (!ichart || !el) return;
    ichart.resize(el.clientWidth, el.clientHeight);
    // 兩端各留幾分鐘邊距，09:00、13:30 的時間標籤才不會被切掉
    resetZoom(ichart, irange);
  }));
}

/** K線／技術分析即時更新：成交進來就更新最後一根，重畫節流為每秒一次 */
let kLiveDirty = false;
function liveBars(t: Tick) {
  if (t.simtrade) return;
  if (mode === 'k' && kBars.length && applyTick(kBars, kunit, t.t, t.price, t.vol, deriv)) kLiveDirty = true;
  if (mode === 'ta' && taBars.length && applyTick(taBars, kunit, t.t, t.price, t.vol, deriv)) kLiveDirty = true;
}
function flushLive() {
  if (!kLiveDirty || pointerHeld()) return;
  kLiveDirty = false;
  if (mode === 'k') renderK(false);
  if (mode === 'ta') taView?.update(taBars);
}

function onTick(t: Tick) {
  onFutOverlay(t);
  if (t.code !== code) return;
  liveBars(t);
  const b = Math.ceil(t.t / 60) * 60;
  if (deriv && !inRange(b)) return;             // 日盤模式時的夜盤成交不畫、不列入統計
  ticks.push(t);
  if (ticks.length > 20000) ticks.splice(0, 5000);
  if (!pxLine) return;
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
let kNote = '';
let taBars: Bar[] = [];
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
  document.getElementById('kinfo')!.textContent = `載入 ${labelOf(kunit)}…（第一次較久）`;
  const built = await buildBars(contract, kunit);
  if (seq !== loadSeq || !mounted || !kchart) return;
  kBars = built.bars;
  vpBars = built.minute;
  kchart.applyOptions({ timeScale: { timeVisible: isMinute(kunit) } });
  kNote = built.note ?? '';
  renderK(true);
}

/** 依 kBars 重畫 K線圖；fit=true 時重設可視範圍（載入時），即時更新時不動使用者的縮放 */
function renderK(fit: boolean) {
  if (!kchart || !candle) return;
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
  const fitK = () => {
    const el = document.getElementById('kchart');
    if (!kchart || !el) return;
    kchart.resize(el.clientWidth, el.clientHeight);
    rchart?.resize(el.clientWidth, document.getElementById('rchart')!.clientHeight);
    kchart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (kunit === 'week' || kunit === 'month' ? 60 : 90)), to: n + 2 });
  };
  if (fit) requestAnimationFrame(() => requestAnimationFrame(fitK));
  const lastR = r[r.length - 1];
  document.getElementById('kinfo')!.innerHTML =
    (tog.ma ? MA.map(([p, c], i) => { const v = sma(closes, p); return `<span style="color:${c}">MA${p} ${fmtP(v[v.length - 1])}</span>`; }).join('') : '') +
    (tog.bb ? `<span class="muted">布林 ${fmtP(bb.up[n - 1])} / ${fmtP(bb.dn[n - 1])}</span>` : '') +
    (tog.rsi ? `<span style="color:#d17cff">RSI14 ${fin(lastR) ? lastR.toFixed(1) : '—'}${lastR > 70 ? ' 過熱' : lastR < 30 ? ' 超賣' : ''}</span>` : '') +
    (tog.vp ? '<span class="accent">▮ 分價量（可視範圍）、◆ 成交最密集價位</span>' : '') +
    (kNote ? `<span class="${/需要|無法|失敗/.test(kNote) ? 'note' : 'muted'}">${esc(kNote)}</span>` : '');
  renderVP();
}

/** 技術分析畫面：1 主 2 副（ui/taview.ts），週期與 K線共用 */
async function loadTA() {
  if (!contract) return;
  const el = document.getElementById('taview')!;
  taView ??= new TAView(el);
  const seq = loadSeq;
  const built = await buildBars(contract, kunit);
  if (seq !== loadSeq || !mounted || !taView) return;
  taBars = built.bars;
  requestAnimationFrame(() => requestAnimationFrame(() => taView?.setBars(taBars, isMinute(kunit))));
}

/** 分價量表：統計目前可視範圍內的成交量分布，畫在 K 線右側 */
function renderVP() {
  const el = document.getElementById('vp');
  if (!el || !kchart || !candle) return;
  if (!tog.vp || !kBars.length) { el.innerHTML = ''; return; }
  const r = kchart.timeScale().getVisibleLogicalRange();
  const from = kBars[Math.max(0, Math.floor(r?.from ?? 0))]?.t ?? 0;
  const to = (kBars[Math.min(kBars.length - 1, Math.ceil(r?.to ?? kBars.length))]?.t ?? Infinity) + (isMinute(kunit) ? Number(kunit.slice(1)) * 60 : (kunit === 'month' ? 31 : kunit === 'week' ? 7 : 1) * 86400);
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
  const held = deriv ? [] : account.state.stkPos.filter((p) => p.code === code);
  const pnl = held.reduce((s, p) => s + account.stockPnl(p), 0);
  const chip = (k: string, v: string, c = '') => `<span class="chip2"><em>${k}</em><b class="${c}">${v}</b></span>`;
  const amp = x ? ((x.high - x.low) / ref) * 100 : NaN;
  const dn = contract && derivName(contract);
  const exp = (contract as { delivery_date?: string } | null)?.delivery_date;
  const fq = hub.quotes.get(hub.futKey);
  const extra = !deriv ? '' : (exp ? chip('結算', exp.slice(5).replace('-', '/')) : '') +
    (contract?.security_type === 'OPT' && fq && fin(fq.last) ? chip('台指期', fmtP(fq.last), cls(fq.last - fq.ref)) : '');
  el.innerHTML = `<div class="sh-l"><div class="sh-n">${esc(dn ?? info?.name ?? nameOf(code))} <small>${code}</small></div>
      <div class="sh-p ${cls(ch)}">${fmtP(last)}<small>${sign(ch, last < 100 ? 2 : 1)}　${fin(ch) ? sign((ch / ref) * 100, 2) + '%' : ''}</small></div></div>
    <div class="sh-chips">
      ${chip('開', fmtP(x?.open ?? NaN), cls((x?.open ?? NaN) - ref))}${chip('高', fmtP(x?.high ?? NaN), 'up')}${chip('低', fmtP(x?.low ?? NaN), 'down')}
      ${chip('參考', fmtP(ref))}${chip('漲停', fmtP(info?.limit_up ?? NaN), 'up')}${chip('跌停', fmtP(info?.limit_down ?? NaN), 'down')}
      ${chip('總量', x ? fmt(x.vol) + (deriv ? ' 口' : ' 張') : '—')}${chip('振幅', fin(amp) ? amp.toFixed(2) + '%' : '—')}${extra}
      ${held.length ? chip('我的庫存', `${held.reduce((s, p) => s + p.quantity, 0)} 張 ${sign(pnl, 0)}`, cls(pnl)) : ''}
    </div>`;
  // 分時圖的參考價虛線
  if (fin(ref) && ref !== refPx) { refPx = ref; ichart?.priceScale('right').applyOptions({ autoScale: true }); }
  if (pxLine && !refLine && fin(ref)) {
    refLine = pxLine.createPriceLine({ price: ref, color: cssVar('--muted'), lineStyle: LineStyle.Dashed, lineWidth: 1, title: '參考' });
  }
  const inGroup = curGroup()?.codes.includes(code);
  const btn = document.getElementById('add-watch')!;
  btn.hidden = deriv || isOptG();
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
/** 期貨／選擇權：以單筆口數分級（中實戶／大戶／法人級的門檻），依商品大小調整 */
function lotTiers(): [number, number, number] {
  if (contract?.security_type === 'OPT') return [10, 50, 200];
  const root = code.slice(0, 3);
  return root === 'TMF' ? [20, 100, 250] : root === 'MXF' ? [10, 40, 100] : [5, 20, 50];
}
/** 單筆成交的分級與統計值：個股＝金額（元）、期貨／選擇權＝口數 */
function tierT(t: Tick) {
  if (!deriv) return tierOf(t.price * t.vol * 1000, t.vol);
  const [a, b, c] = lotTiers();
  return t.vol >= c ? 3 : t.vol >= b ? 2 : t.vol >= a ? 1 : 0;
}
const valT = (t: Tick) => (deriv ? t.vol : t.price * t.vol * 1000);
const TIER = ['散戶', '中實戶', '大戶', '法人級'];
const TIER_COLOR = ['#8b95a3', '#8fb3ff', '#f5b94a', '#d17cff'];
const wan = (n: number) => (deriv ? Math.round(n).toLocaleString() + '口' : Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + '億' : Math.round(n / 1e4).toLocaleString() + '萬');

function renderFlow() {
  let outV = 0, inV = 0;
  const buy = [0, 0, 0, 0], sell = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
  for (const t of ticks) {
    const amt = valT(t);
    const k = tierT(t);
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

const fmtMoney = (v: number) => (deriv ? Math.round(v).toLocaleString() + '口' : Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4).toLocaleString() + '萬');

function initFlowChart() {
  const el = document.getElementById('flowchart')!;
  fchart = createChart(el, {
    ...chartOpts(),
    // 小圖不放 TradingView 標誌（會壓住線）；同頁的分時主圖保留標誌作為出處標示
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10, attributionLogo: false },
    // 全時時間軸有 1,140 點，小圖寬度不夠；預設最小間距 0.5px 會把可視範圍截斷（pitfalls #19）
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0, minBarSpacing: 0.05 },
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
    fchart.timeScale().setVisibleLogicalRange(irange);
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
    const amt = valT(tk);
    const k = tierT(tk);
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
    const k = tierT(t);
    if (onlyBig && k < 2) continue;
    const time = new Date(t.t * 1000).toISOString().slice(11, 19);
    out.push(`<div class="tk-r${k ? ' big' + k : ''}"><span class="tm">${time}</span>
      <span class="pr ${t.side === 1 ? 'up' : t.side === 2 ? 'down' : ''}">${fmtP(t.price)}</span>
      <span class="vl">${fmt(t.vol)}</span><span class="sd ${t.side === 1 ? 'up' : 'down'}">${t.side === 1 ? '外' : t.side === 2 ? '內' : ''}</span>
      <span class="tg">${k ? `<span class="tag t${k}">${TIER[k]}</span>` : ''}</span></div>`);
  }
  document.getElementById('ticks')!.innerHTML = out.join('') || '<div class="muted">尚無成交</div>';
}

function setInterval2(u: string) {
  kunit = u; LS.set('stkUnit', u); applyMode();
  if (mode === 'ta') loadTA(); else loadK();
}

function applyMode() {
  document.querySelectorAll<HTMLElement>('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
  const custom = isMinute(kunit) && !INTERVALS.some((x) => x[0] === kunit);
  const btn = ([id, name]: [string, string]) => `<button data-u="${id}" class="${id === kunit ? 'on' : ''}">${name}</button>`;
  const mins = INTERVALS.filter(([id]) => isMinute(id)), rest = INTERVALS.filter(([id]) => !isMinute(id));
  // 比照券商：分鐘按鈕後面放一個輸入欄，輸入分鐘數按 Enter 套用
  document.getElementById('kunit')!.innerHTML = mins.map(btn).join('') +
    `<span class="kmin${custom ? ' on' : ''}"><input id="kmin" type="number" min="1" max="240" placeholder="分" value="${custom ? kunit.slice(1) : ''}" title="自訂分鐘，輸入後按 Enter">分</span>` +
    rest.map(btn).join('');
  document.querySelectorAll<HTMLElement>('#ktog button').forEach((b) => b.classList.toggle('on', !!tog[b.dataset.t!]));
  document.getElementById('live')!.hidden = mode !== 'live';
  document.getElementById('kview')!.hidden = mode !== 'k';
  document.getElementById('taview')!.hidden = mode !== 'ta';
  document.getElementById('ta-gear')!.hidden = mode !== 'ta';
  document.getElementById('kunit')!.hidden = mode === 'live';
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
    const exp = t.closest<HTMLElement>('[data-exp]')?.dataset.exp;
    if (exp) { toggleExp(exp); return; }
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
    groupId = (ev.target as HTMLSelectElement).value; LS.set('stkGroup', groupId);
    renderGroups(); syncWatchSubs(); syncOptSubs(); dirty = true;
  });
  el.querySelector('#wl-add-g')!.addEventListener('click', () => {
    const name = prompt('新群組名稱', '')?.trim();
    if (!name) return;
    const id = 'g' + Date.now();
    store.update((d) => d.groups.push({ id, name, codes: [] }));
    groupId = id; LS.set('stkGroup', id);
  });
  el.querySelector('#wl-ren-g')!.addEventListener('click', () => {
    if (isOptG()) return;
    const g = curGroup(); if (!g) return;
    const name = prompt('群組新名稱', g.name)?.trim();
    if (name) store.update(() => { g.name = name; });
  });
  el.querySelector('#wl-del-g')!.addEventListener('click', () => {
    if (isOptG()) return;
    const g = curGroup(); if (!g || groups().length <= 1) { alert('至少要保留一個群組'); return; }
    if (!confirm(`刪除群組「${g.name}」（${g.codes.length} 檔）？`)) return;
    store.update((d) => { d.groups = d.groups.filter((x) => x.id !== g.id); });
    groupId = groups()[0].id; LS.set('stkGroup', groupId);
  });
  el.querySelector('#add-watch')!.addEventListener('click', () => {
    store.update(() => {
      const g = curGroup(); if (!g || !code || isOptG()) return;
      g.codes = g.codes.includes(code) ? g.codes.filter((c) => c !== code) : [...g.codes, code];
    });
  });
  el.querySelector('#mode')!.addEventListener('click', (ev) => {
    const m = (ev.target as HTMLElement).dataset.m as Mode | undefined;
    if (!m || m === mode) return;
    mode = m; LS.set('stkMode', m); applyMode(); dirty = true;
    if (m === 'live') { fitSession(); fitFlow(); }
    if (m === 'k') loadK();
    if (m === 'ta') loadTA();
  });
  el.querySelector('#kunit')!.addEventListener('click', (ev) => {
    const u = (ev.target as HTMLElement).closest<HTMLElement>('[data-u]')?.dataset.u;
    if (u) setInterval2(u);
  });
  el.querySelector('#ta-gear')!.addEventListener('click', () => taView?.openModal());
  el.querySelector('#isess')!.addEventListener('click', (ev) => {
    const v = (ev.target as HTMLElement).dataset.s as Sess | undefined;
    if (!v || v === sess) return;
    sess = v; manualSess = true; loadLive();
  });
  el.querySelector('#kunit')!.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent, inp = e.target as HTMLInputElement;
    if (inp.id !== 'kmin' || e.key !== 'Enter') return;
    const n = Math.round(Number(inp.value));
    if (!(n >= 1 && n <= 240)) { inp.select(); return; }
    setInterval2('m' + n);
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
  title: '分析',
  mount(el) {
    mounted = true;
    dirty = true;
    el.innerHTML = TEMPLATE;
    // 每次進入都重新讀取模式（商品頁點小卡會先設定成 K 線模式，見 core/nav.ts）
    mode = (LS.get('stkMode') as Mode) ?? 'live';
    bind(el);
    applyMode();
    initIntraday();
    initFlowChart();
    initK();
    account.use('stocks');
    renderGroups();
    cleanups.push(hub.on('change', () => { dirty = true; }));
    cleanups.push(hub.on('tick', onTick));
    const liveTimer = setInterval(flushLive, 1000);
    cleanups.push(() => clearInterval(liveTimer));
    cleanups.push(hub.on('index', onIndex));
    // 期貨／選擇權：日盤⇄夜盤自動切換；時段跑出目前時間軸時重新載入
    const sessTimer = setInterval(() => {
      if (!deriv || pointerHeld()) return;
      const nowB = Math.ceil((Date.now() / 1000 + 8 * 3600) / 60) * 60;
      if (!manualSess && autoSess() !== sess) { sess = autoSess(); loadLive(); }
      else if (session() !== 'closed' && nowB > rangeHi + 60 && !inRange(nowB)) loadLive();
    }, 60_000);
    cleanups.push(() => clearInterval(sessTimer));
    cleanups.push(hub.on('fut', () => { loadDerivDefaults(); dirty = true; }));
    loadDerivDefaults();
    cleanups.push(account.on(() => { dirty = true; syncWatchSubs(); }));
    cleanups.push(store.on(() => { renderGroups(); syncWatchSubs(); syncOptSubs(); dirty = true; }));
    const onHash = () => { const c = codeFromHash(); if (location.hash.startsWith('#/stocks') && c) open(c); };
    window.addEventListener('hashchange', onHash);
    cleanups.push(() => window.removeEventListener('hashchange', onHash));
    const onResize = () => renderVP();
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));
    store.load();
    syncWatchSubs();
    code = '';
    open(codeFromHash() || LS.get('stkCode') || (isOptG() ? hub.futKey : curGroup()?.codes[0]) || '2330');
    frame();
  },
  unmount() {
    mounted = false;
    loadSeq++;
    clearTimeout(timer);
    cleanups.splice(0).forEach((f) => f());
    hub.releaseAll(OWNER_WL);
    hub.releaseAll(OWNER_CUR);
    hub.releaseAll(OWNER_EXP);
    expCenter.clear(); tmfNear = null; optExp = [];
    account.unuse('stocks');
    wlSubs = new Set();
    contract = null; code = '';
    ichartRO?.disconnect(); ichartRO = null;
    taView?.destroy(); taView = null;
    fchartRO?.disconnect(); fchartRO = null;
    fchart?.remove(); fchart = null; fLines = []; fAxis = null; flowTicksLen = -1;
    ichart?.remove(); kchart?.remove(); rchart?.remove();
    ichart = kchart = rchart = null; pxLine = vwLine = axisLine = ixOverlay = null; ixDay = ''; ivol = null; candle = null; kvol = null; rsiS = null;
    maS = []; bbS = []; refLine = null;
  },
};
