// 總覽：一眼看全局（需求：docs/ai/requirements.md 第 1–5 輪）
//   上：大盤｜台指期｜期權摘要（最近到期）
//   中：加權＋台指期今日走勢（疊圖）
//   下：權值股前 10｜產業類股熱力圖
//   底：今日損益｜期貨權益與風險｜持倉概況
import { ColorType, createChart, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { account } from '../core/account';
import { components } from '../core/components';
import { hub } from '../core/hub';
import { computeMetrics, type Expiry, loadTxoExpiries, pcrLabel, skewLabel } from '../core/optchain';
import { cls, cssVar, esc, fin, fmt, session, sign, tpeToday, pointerHeld } from '../core/util';
import { Heatmap } from '../ui/heatmap';
import type { Bar } from '../types';
import type { Page } from './page';

const OWNER = 'overview';

const TEMPLATE = `
<section class="ov">
  <div class="ov-row three">
    <div class="card ov-card" id="ov-mkt"></div>
    <div class="card ov-card" id="ov-fut"></div>
    <div class="card ov-card hero" id="ov-opt"></div>
  </div>
  <div class="card ov-chart-card">
    <div class="ct">今日走勢　<span class="lgd"><i class="l-ix"></i>加權指數　<i class="l-fut"></i><span id="ov-fut-name">台指期</span></span></div>
    <div id="ov-chart" class="ov-chart"></div>
  </div>
  <div class="ov-row two">
    <div class="card ov-card" id="ov-heavy"></div>
    <div class="card ov-card"><div class="ct">產業類股熱力圖<span class="tip" title="方塊大小＝權重、顏色＝類股加權漲跌幅、數字＝對大盤的貢獻點數。光點密度＝每秒成交金額（資金流量）；往上紅點＝正在推升指數，往下綠點＝正在拖累">?</span>
      <span id="ov-heat-tag" class="ct-r hm-tag"></span></div>
      <div class="heat"><div id="ov-heat" class="heat-c"></div><div id="ov-heat-empty" class="muted heat-empty" hidden></div></div>
      <div id="ov-heat-diag" class="heat-diag"></div></div>
  </div>
  <div class="ov-row three">
    <div class="card ov-card hero" id="ov-pnl"></div>
    <div class="card ov-card" id="ov-margin"></div>
    <div class="card ov-card" id="ov-pos"></div>
  </div>
</section>`;

let mounted = false;
let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const cleanups: (() => void)[] = [];
let nearest: Expiry | null = null;

// ───────── 大盤 / 台指期 / 期權摘要 ─────────
function renderMarket() {
  const i = hub.idx, o = hub.indices.get('IX0043');
  const el = document.getElementById('ov-mkt');
  if (!el) return;
  if (!i) { el.innerHTML = '<div class="ct">大盤</div><div class="muted">載入中…</div>'; return; }
  const ch = i.close - i.reference;
  const up = (i.raise ?? NaN) + (i.raiseStop ?? 0), dn = (i.fall ?? NaN) + (i.fallStop ?? 0);
  const breadth = fin(up) && fin(dn) && up + dn > 0 ? `
    <div class="brk"><span class="up">▲${fmt(up)}<small>${i.raiseStop ? ` 漲停${i.raiseStop}` : ''}</small></span>
      <span class="down">▼${fmt(dn)}<small>${i.fallStop ? ` 跌停${i.fallStop}` : ''}</small></span></div>
    <div class="pcbar"><i style="width:${(up / (up + dn)) * 100}%"></i></div>` : '';
  const amt = fin(i.amountSum) && i.amountSum > 0
    ? `成交 <b>${(i.amountSum / 1e8).toFixed(0)}</b> 億${fin(i.prevAmountSum ?? NaN) && i.prevAmountSum ? `（昨 ${(i.prevAmountSum / 1e8).toFixed(0)} 億）` : ''}` : '';
  const otc = o ? `<div class="sub2">櫃買 <b class="${cls(o.close - o.reference)}">${fmt(o.close, 2)}</b>
    <span class="${cls(o.close - o.reference)}">${sign(((o.close - o.reference) / o.reference) * 100, 2)}%</span></div>` : '';
  el.innerHTML = `<div class="ct">加權指數</div>
    <div class="cm ${cls(ch)}">${fmt(i.close, 2)}</div>
    <div class="${cls(ch)}">${sign(ch, 2)}　${sign((ch / i.reference) * 100, 2)}%</div>
    ${otc}<div class="sub2">${amt}</div>${breadth}`;
}

function renderFut() {
  const el = document.getElementById('ov-fut');
  const f = hub.quotes.get(hub.futKey);
  if (!el) return;
  if (!f) { el.innerHTML = `<div class="ct">${hub.futName}</div><div class="muted">載入中…</div>`; return; }
  const ch = f.last - f.ref;
  const basis = hub.idx ? f.last - hub.idx.close : NaN;
  const basisHtml = session() === 'day'
    ? `基差 <b class="${cls(basis)}">${sign(basis, 1)}</b> ${fin(basis) ? (basis >= 0 ? '正價差' : '逆價差') : ''}`
    : `較現貨收盤 <b class="${cls(basis)}">${sign(basis, 0)}</b>`;
  const bs = f.bidSideVol, as = f.askSideVol;
  const inout = fin(bs) && fin(as) && bs + as > 0
    ? `<div class="sub2">外盤 <b class="up">${fmt(bs)}</b>　內盤 <b class="down">${fmt(as)}</b></div>
       <div class="pcbar"><i style="width:${(bs / (bs + as)) * 100}%"></i></div>` : '';
  el.innerHTML = `<div class="ct">${hub.futName}</div>
    <div class="cm ${cls(ch)}">${fmt(f.last)}</div>
    <div class="${cls(ch)}">${sign(ch)}　${sign((ch / f.ref) * 100, 2)}%</div>
    <div class="sub2">${basisHtml}</div>
    <div class="sub2">高 <b class="up">${fmt(f.high)}</b>　低 <b class="down">${fmt(f.low)}</b>　量 <b>${fmt(f.vol)}</b></div>${inout}`;
}

function renderOpt() {
  const el = document.getElementById('ov-opt');
  if (!el) return;
  if (!nearest) { el.innerHTML = '<div class="ct">期權摘要</div><div class="muted">載入選擇權…</div>'; return; }
  const m = computeMetrics(nearest);
  const hrs = m.T * 365 * 24;
  const left = hrs >= 24 ? `${Math.floor(hrs / 24)}天${Math.floor(hrs % 24)}時` : `${Math.floor(hrs)}時${Math.floor((hrs * 60) % 60)}分`;
  const cw = m.callVol + m.putVol ? (m.callVol / (m.callVol + m.putVol)) * 100 : 50;
  el.innerHTML = `<div class="ct">期權摘要・${nearest.label} ${nearest.kind}（剩 ${left}）
      <span class="tip" title="最近到期的選擇權，以快照約 10 秒更新；點擊進入期權頁">?</span></div>
    <div class="kpis">
      <div><span>預期區間</span><b class="accent">${fin(m.straddle) ? '±' + fmt(m.straddle) : '—'}</b>
        <small>${fin(m.straddle) ? `${fmt(m.F - m.straddle)}～${fmt(m.F + m.straddle)}` : ''}</small></div>
      <div><span>價平 IV</span><b>${fin(m.atmIV) ? (m.atmIV * 100).toFixed(1) + '%' : '—'}</b>
        <small>偏斜 ${fin(m.skew) ? (m.skew > 0 ? '+' : '') + m.skew.toFixed(1) : '—'} ${skewLabel(m.skew)}</small></div>
      <div><span>壓力／支撐</span><b><span class="up">${m.maxCall ? fmt(m.maxCall.k) : '—'}</span> / <span class="down">${m.maxPut ? fmt(m.maxPut.k) : '—'}</span></b>
        <small>價平 ${m.atm ? fmt(m.atm.k) : '—'}・合成 ${fmt(m.F, 0)}</small></div>
      <div><span>P/C 量比</span><b>${fin(m.pcr) ? m.pcr.toFixed(2) : '—'}</b><small>${pcrLabel(m.pcr)}</small>
        <div class="pcbar"><i style="width:${cw}%"></i></div></div>
    </div>`;
}

// ───────── 走勢圖：加權＋台指期疊圖 ─────────
let chart: IChartApi | null = null;
let ixLine: ISeriesApi<'Line'> | null = null;
let futLine: ISeriesApi<'Line'> | null = null;
let lastIxT = 0, lastFutT = 0;

function initChart() {
  const el = document.getElementById('ov-chart')!;
  chart = createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11 },
    grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  });
  ixLine = chart.addSeries(LineSeries, { color: '#c9d1d9', lineWidth: 2, title: '加權', priceLineVisible: false });
  futLine = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, title: '台指', priceLineVisible: false });
}

async function loadChart() {
  if (!hub.fut || !chart) return;
  const [ixBars, futBars] = await Promise.all([
    hub.be.kbars(hub.ixContract, tpeToday(-6), tpeToday()).catch(() => [] as Bar[]),
    hub.be.kbars(hub.fut, tpeToday(-6), tpeToday()).catch(() => [] as Bar[]),
  ]);
  if (!mounted || !chart) return;
  const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  // 以加權指數最後一個交易日為準；期貨取同一天日盤＋接著的夜盤
  const D = ixBars.length ? date(ixBars[ixBars.length - 1].t) : (futBars.length ? date(futBars[futBars.length - 1].t) : '');
  const next = new Date(Date.parse(D + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);
  const ix = ixBars.filter((b) => date(b.t) === D);
  const fut = futBars.filter((b) => {
    const d = date(b.t), h = new Date(b.t * 1000).getUTCHours();
    return (d === D) || (d === next && h < 5);
  });
  ixLine!.setData(ix.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
  futLine!.setData(fut.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
  lastIxT = ix.length ? ix[ix.length - 1].t : 0;
  lastFutT = fut.length ? fut[fut.length - 1].t : 0;
  chart.timeScale().fitContent();
}

function bucket(t: number) { return Math.ceil(t / 60) * 60; } // shioaji 1 分 K 以結束時間標記

// ───────── 權值股前 10 ─────────
function renderHeavy() {
  const el = document.getElementById('ov-heavy');
  if (!el) return;
  const list = components.heavies(10);
  const mx = Math.max(1, ...list.map((h) => Math.abs(h.contrib)).filter(fin));
  const sum = list.reduce((s, h) => s + (fin(h.contrib) ? h.contrib : 0), 0);
  el.innerHTML = `<div class="ct">權值股前 10<span class="tip" title="依加權指數權重排序；貢獻點數＝這檔股票讓大盤漲跌了幾點。點一下看個股">?</span>
      <span class="ct-r">合計 <b class="${cls(sum)}">${sign(sum, 1)}</b> 點</span></div>
    <table class="hv"><tbody>${list.map((h) => {
      const w = fin(h.contrib) ? (Math.abs(h.contrib) / mx) * 50 : 0;
      return `<tr data-code="${h.code}">
        <td class="nm"><b>${esc(h.name)}</b><small>${h.code}</small></td>
        <td class="wt">${fin(h.weight) ? (h.weight * 100).toFixed(1) + '%' : ''}</td>
        <td class="px ${cls(h.pct)}">${fin(h.price) ? fmt(h.price, h.price < 100 ? 2 : 0) : '—'}</td>
        <td class="pct ${cls(h.pct)}">${fin(h.pct) ? sign(h.pct, 2) + '%' : ''}</td>
        <td class="cb"><div class="zbar"><i class="${h.contrib >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></i></div></td>
        <td class="cv ${cls(h.contrib)}">${fin(h.contrib) ? sign(h.contrib, 1) : '—'}</td></tr>`;
    }).join('')}</tbody></table>`;
}

// ───────── 類股熱力圖（Canvas 動畫，src/ui/heatmap.ts） ─────────
let heat: Heatmap | null = null;
function renderHeat() {
  const st = components.sectorState();
  const tag = document.getElementById('ov-heat-tag');
  if (tag) {
    const asOf = st.asOf.replace(/^\d{4}-/, '').replace('-', '/').slice(0, 11);
    tag.innerHTML = st.live ? '<span class="live-dot"></span>即時' : st.list.length ? `收盤${asOf ? ' ' + asOf : ''}` : '';
    tag.className = 'ct-r hm-tag' + (st.live ? ' live' : '');
  }
  const empty = document.getElementById('ov-heat-empty')!;
  empty.hidden = st.list.length > 0;
  empty.textContent = session() === 'day' ? '載入中…' : '盤後尚無收盤資料：今天盤中開過總覽後，盤後就會顯示收盤值';
  heat?.setData(st.list, st.live);
  // 診斷列（之後確認正常可移除）
  const d = components.diag;
  const n = (m: string) => d.recv[`group_metric/${m}`] ?? 0;
  const ago = d.lastAt ? `${Math.round((Date.now() - d.lastAt) / 1000)} 秒前` : '尚未收到';
  const others = Object.entries(d.recv).filter(([k]) => !k.startsWith('group_metric/') && !k.startsWith('ranking/')).map(([k, v]) => `${k}=${v}`).join(' ');
  document.getElementById('ov-heat-diag')!.textContent =
    `類股串流：貢獻 ${n('contribution')}・權重 ${n('weight')}・漲跌 ${n('weighted_performance')}・金額 ${n('amount')} 筆｜試撮 ${d.simtrade}｜最後收到 ${ago}｜類股 ${st.list.length} 個`
    + (others ? `｜其他 ${others}` : '') + (d.errors.length ? `｜訂閱錯誤：${d.errors.join('；')}` : '');
}

// ───────── 帳戶 ─────────
const money = (n: number) => (fin(n) ? sign(n, 0) : '—');
/** 永豐部位代碼轉成好讀的名稱：TXO20261228000C → TXO 12月 28000 買權 */
function posName(code: string) {
  if (code === hub.futKey) return hub.futName;
  const m = code.match(/^([A-Z0-9]{3})(\d{4})(\d{2})(\d+)([CP])$/);
  if (m) return `${m[1]} ${+m[3]}月 ${m[4]} ${m[5] === 'C' ? '買權' : '賣權'}`;
  return code;
}
function renderAccount() {
  const s = account.state;
  const t = account.totals();
  const pnlEl = document.getElementById('ov-pnl'), mEl = document.getElementById('ov-margin'), pEl = document.getElementById('ov-pos');
  if (!pnlEl || !mEl || !pEl) return;
  const loading = !s.ready ? '<div class="muted">查詢帳務中…</div>' : '';
  const noS = s.ready && !s.sAccount ? '<div class="note">API Key 尚未綁定證券帳戶，證券部分無資料</div>' : '';
  const realized = (fin(t.realizedF) ? t.realizedF : 0) + (fin(t.realizedS) ? t.realizedS : 0);
  const unreal = t.unrealF + t.unrealS;
  const total = realized + unreal;
  pnlEl.innerHTML = `<div class="ct">今日損益<span class="tip" title="今日已實現損益＋目前持倉未實現損益。股票未實現損益即時跳動，期權約 15 秒更新">?</span></div>
    ${loading || `<div class="cm ${cls(total)}">${money(total)}</div>
    <div class="kv2"><span>已實現（今日）</span><b class="${cls(realized)}">${money(realized)}</b></div>
    <div class="kv2"><span>未實現・期權</span><b class="${cls(t.unrealF)}">${money(t.unrealF)}</b></div>
    <div class="kv2"><span>未實現・證券</span><b class="${cls(t.unrealS)}">${s.sAccount ? money(t.unrealS) : '—'}</b></div>`}${noS}`;

  const m = s.margin;
  const risk = m?.risk_indicator ?? NaN;
  const riskCls = !fin(risk) || risk >= 900 ? '' : risk < 100 ? 'danger' : risk < 150 ? 'warn' : 'ok';
  mEl.innerHTML = `<div class="ct">期貨權益與風險</div>
    ${m ? `<div class="cm">${fmt(m.equity)}</div>
    <div class="kv2"><span>可用保證金</span><b>${fmt(m.available_margin)}</b></div>
    <div class="kv2"><span>維持保證金</span><b>${fmt(m.maintenance_margin)}</b></div>
    <div class="kv2"><span>風險指標</span><b class="risk ${riskCls}">${fin(risk) && risk < 900 ? risk.toFixed(0) + '%' : '無部位'}</b></div>`
    : s.errors.margin ? `<div class="note">查詢失敗：${esc(s.errors.margin)}</div>` : loading}`;

  const rows = [
    ...s.futPos.map((p) => `<tr><td title="${esc(p.code)}">${esc(posName(p.code))}</td><td class="${p.direction === 'Sell' ? 'down' : 'up'}">${p.direction === 'Sell' ? '賣' : '買'} ${p.quantity}口</td>
      <td class="r ${cls(p.pnl)}">${money(p.pnl)}</td></tr>`),
    ...s.stkPos.map((p) => { const v = account.stockPnl(p); return `<tr data-code="${esc(p.code)}"><td>${esc(p.code)}</td>
      <td>${p.direction === 'Sell' ? '券賣' : '現股'} ${p.quantity}張</td><td class="r ${cls(v)}">${money(v)}</td></tr>`; }),
  ];
  pEl.innerHTML = `<div class="ct">持倉概況<span class="ct-r">${s.futPos.length} 期權・${s.stkPos.length} 股票</span></div>
    ${!s.ready ? loading : rows.length ? `<div class="pos-wrap"><table class="pos"><tbody>${rows.join('')}</tbody></table></div>` : '<div class="muted">目前沒有持倉</div>'}${noS}`;
}

// ───────── 主迴圈 ─────────
function frame() {
  if (!mounted) return;
  if (dirty && !pointerHeld()) {
    dirty = false;
    renderMarket(); renderFut(); renderOpt(); renderHeavy(); renderHeat(); renderAccount();
  }
  timer = setTimeout(() => requestAnimationFrame(frame), 500);
}

async function loadNearest() {
  try {
    const list = await loadTxoExpiries();
    nearest = list[0] ?? null;
    if (nearest) await hub.loadSnapshots(nearest.list);
  } catch (e) { console.warn('overview options', e); }
  dirty = true;
}

export const overviewPage: Page = {
  id: 'overview',
  title: '總覽',
  mount(el) {
    mounted = true;
    dirty = true;
    el.innerHTML = TEMPLATE;
    document.getElementById('ov-fut-name')!.textContent = hub.futName;
    initChart();
    heat = new Heatmap(document.getElementById('ov-heat')!);
    components.use(OWNER);
    account.use(OWNER);
    hub.acquire(OWNER, { security_type: 'IND', exchange: 'OTC', code: 'IX0043' }, ['Quote']);
    cleanups.push(hub.on('change', () => { dirty = true; }));
    cleanups.push(account.on(() => { dirty = true; }));
    cleanups.push(hub.on('tick', (t) => {
      if (t.code !== hub.futKey || !futLine) return;
      const b = bucket(t.t);
      if (b < lastFutT) return;
      lastFutT = b;
      futLine.update({ time: b as UTCTimestamp, value: t.price });
    }));
    cleanups.push(hub.on('index', (i) => {
      if (i.code !== 'IX0001' || !ixLine || !i.t) return;
      const b = bucket(i.t);
      if (b < lastIxT || !fin(i.close)) return;
      lastIxT = b;
      ixLine.update({ time: b as UTCTimestamp, value: i.close });
    }));
    cleanups.push(hub.on('fut', () => {
      document.getElementById('ov-fut-name')!.textContent = hub.futName;
      loadChart();
    }));
    const onResize = () => { dirty = true; };
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));
    document.getElementById('ov-heavy')!.addEventListener('click', (ev) => {
      const code = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-code]')?.dataset.code;
      if (code) location.hash = `#/stocks/${code}`;
    });
    document.getElementById('ov-opt')!.addEventListener('click', () => { location.hash = '#/options'; });
    const timers = [setInterval(() => { if (nearest) hub.loadSnapshots(nearest.list); }, 10_000), setInterval(loadNearest, 10 * 60_000)];
    cleanups.push(() => timers.forEach(clearInterval));
    loadNearest();
    loadChart();
    frame();
  },
  unmount() {
    mounted = false;
    clearTimeout(timer);
    cleanups.splice(0).forEach((f) => f());
    components.unuse(OWNER);
    account.unuse(OWNER);
    hub.releaseAll(OWNER);
    chart?.remove();
    heat?.destroy(); heat = null;
    chart = null; ixLine = null; futLine = null; lastIxT = 0; lastFutT = 0;
  },
};
