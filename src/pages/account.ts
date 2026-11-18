// 帳務頁（需求：docs/ai/requirements.md 第 1、3、6 輪）
//   上：期貨權益與風險｜組合 Greeks｜證券摘要與交割款
//   中：期權部位（即時損益、Delta、IV）｜到期損益圖
//   下：證券庫存（今日損益、市值佔比）
//   底：已實現損益（自選期間、每日長條圖、明細）
import { greeks, impliedVol, price as bsPrice, yearsToExpiry } from '../bs';
import { account, type Position } from '../core/account';
import { hub, keyOf } from '../core/hub';
import { type Expiry, fair, rowsOf, synthetic } from '../core/optchain';
import { cls, esc, fin, fmt, fmtP, sign, tpeNow, tpeToday } from '../core/util';
import type { Page } from './page';

const OWNER = 'account-page';

const TEMPLATE = `
<section class="ov acct">
  <div class="ov-row three">
    <div class="card ov-card" id="ac-margin"></div>
    <div class="card ov-card" id="ac-greeks"></div>
    <div class="card ov-card" id="ac-stk"></div>
  </div>
  <div class="ov-row two">
    <div class="card ov-card" id="ac-fpos"></div>
    <div class="card ov-card"><div class="ct">到期損益圖<span class="tip" title="橫軸＝結算時的指數；實線＝到期損益，虛線＝目前（以現在的 IV 估算）。黃點＝損益兩平">?</span>
      <span class="ct-r lgd"><i class="l-fut"></i>到期　<i class="l-now"></i>目前</span></div><div id="ac-payoff" class="payoff"></div></div>
  </div>
  <div class="card ov-card" id="ac-spos"></div>
  <div class="card ov-card">
    <div class="ct">已實現損益
      <span class="ct-r rl-ctl">
        <button data-r="today">今日</button><button data-r="week">本週</button><button data-r="month">本月</button><button data-r="year">今年</button>
        <input type="date" id="rl-b"> ～ <input type="date" id="rl-e">
      </span></div>
    <div id="ac-realized"></div>
  </div>
</section>`;

let mounted = false;
let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const cleanups: (() => void)[] = [];

const money = (n: number) => (fin(n) ? sign(n, 0) : '—');
const posName = (code: string) => {
  const m = account.mapped.get(code);
  if (m?.kind === 'fut') return code === hub.futKey ? hub.futName : code;
  const o = code.match(/^([A-Z0-9]{3})(\d{4})(\d{2})(\d+)([CP])$/);
  if (o) return `${o[1]} ${+o[3]}月 ${o[4]} ${o[5] === 'C' ? '買權' : '賣權'}`;
  return code;
};

// ───────── 期權部位的 Greeks ─────────
interface PosCalc {
  p: Position; pnl: number; last: number; sgn: number; mult: number;
  kind?: 'fut' | 'opt'; iv: number; delta: number; gamma: number; theta: number; vega: number; // 部位合計（已乘口數×乘數）
  F: number; T: number; K: number; right?: 'C' | 'P'; expiry?: Expiry;
}
const fCache = new Map<Expiry, number>();
function calcPositions(): PosCalc[] {
  fCache.clear();
  return account.state.futPos.map((p) => {
    const m = account.mapped.get(p.code);
    const sgn = p.direction === 'Sell' ? -1 : 1;
    const mult = m?.mult ?? NaN;
    const last = m ? hub.quotes.get(keyOf(m.contract))?.last ?? p.last_price : p.last_price;
    const base: PosCalc = { p, pnl: account.futPnl(p), last, sgn, mult, kind: m?.kind, iv: NaN, delta: NaN, gamma: 0, theta: 0, vega: 0, F: NaN, T: NaN, K: NaN };
    if (m?.kind === 'fut') return { ...base, delta: sgn * p.quantity * mult };
    if (m?.kind === 'opt' && m.opt && m.expiry) {
      let F = fCache.get(m.expiry);
      if (F === undefined) { F = synthetic(rowsOf(m.expiry)); fCache.set(m.expiry, F); }
      const T = yearsToExpiry(m.expiry.date);
      const px = fair(keyOf(m.contract));
      const iv = impliedVol(fin(px) ? px : last, F, m.opt.strike, T, m.opt.right);
      const g = fin(iv) ? greeks(F, m.opt.strike, T, iv, m.opt.right) : null;
      const k = sgn * p.quantity * mult;
      return { ...base, iv, F, T, K: m.opt.strike, right: m.opt.right, expiry: m.expiry,
        delta: g ? k * g.delta : NaN, gamma: g ? k * g.gamma : 0, theta: g ? k * g.theta : 0, vega: g ? k * g.vega : 0 };
    }
    return base;
  });
}

// ───────── 上排 ─────────
function renderMargin() {
  const el = document.getElementById('ac-margin')!;
  const s = account.state, m = s.margin;
  const risk = m?.risk_indicator ?? NaN;
  const riskCls = !fin(risk) || risk >= 900 ? '' : risk < 100 ? 'danger' : risk < 150 ? 'warn' : 'ok';
  el.innerHTML = `<div class="ct">期貨權益與風險<span class="tip" title="風險指標低於 150% 黃色、低於 100% 紅色；低於 25% 期貨商會結清部位">?</span>
      <span class="ct-r">${s.fAccount ? esc(s.fAccount.broker_id + '-' + s.fAccount.account_id) : ''}</span></div>
    ${m ? `<div class="cm">${fmt(m.equity)}</div>
      <div class="kv2"><span>風險指標</span><b class="risk ${riskCls}">${fin(risk) && risk < 900 ? risk.toFixed(0) + '%' : '無部位'}</b></div>
      <div class="kv2"><span>可用保證金</span><b>${fmt(m.available_margin)}</b></div>
      <div class="kv2"><span>原始／維持保證金</span><b>${fmt(m.initial_margin)} ／ ${fmt(m.maintenance_margin)}</b></div>
      <div class="kv2"><span>昨日／今日餘額</span><b>${fmt(m.yesterday_balance)} ／ ${fmt(m.today_balance)}</b></div>`
    : s.errors.margin ? `<div class="note">查詢失敗：${esc(s.errors.margin)}</div>` : s.ready && !s.fAccount ? '<div class="note">沒有期權帳戶</div>' : '<div class="muted">查詢中…</div>'}`;
}

function renderGreeks(pcs: PosCalc[]) {
  const el = document.getElementById('ac-greeks')!;
  const sum = (k: 'delta' | 'gamma' | 'theta' | 'vega') => pcs.reduce((s, x) => s + (fin(x[k]) ? x[k] : 0), 0);
  const d = sum('delta'), g = sum('gamma'), th = sum('theta'), v = sum('vega');
  const any = pcs.length > 0;
  el.innerHTML = `<div class="ct">組合 Greeks<span class="tip" title="Delta：約當台指期口數（大台 1 口＝每點 200 元）；Theta：每過一天時間價值收支；Vega：IV 每變動 1 個百分點的損益">?</span></div>
    ${any ? `<div class="kpis">
      <div><span>Delta（約當大台）</span><b class="${cls(d)}">${fin(d) ? sign(d / 200, 2) + ' 口' : '—'}</b><small>指數每漲 1 點 ${money(d)} 元</small></div>
      <div><span>Theta（每天）</span><b class="${cls(th)}">${money(th)}</b><small>${th >= 0 ? '時間站在你這邊' : '每天付出時間價值'}</small></div>
      <div><span>Gamma（每漲 100 點）</span><b class="${cls(g)}">${fin(g) ? sign((g * 100) / 200, 2) + ' 口' : '—'}</b><small>${g >= 0 ? '上漲時 Delta 增加' : '上漲時 Delta 減少'}</small></div>
      <div><span>Vega（IV +1%）</span><b class="${cls(v)}">${money(v)}</b><small>${v >= 0 ? '波動放大有利' : '波動放大不利'}</small></div>
    </div>` : `<div class="muted">${account.state.ready ? '目前沒有期權部位' : '查詢中…'}</div>`}`;
}

function renderStkSummary() {
  const el = document.getElementById('ac-stk')!;
  const s = account.state;
  if (s.ready && !s.sAccount) {
    el.innerHTML = '<div class="ct">證券帳戶</div><div class="note">API Key 尚未綁定證券帳戶</div>'; return;
  }
  let mv = 0, unreal = 0, today = 0;
  for (const p of s.stkPos) {
    const x = hub.quotes.get(p.code);
    const last = x?.last ?? p.last_price, sg = p.direction === 'Sell' ? -1 : 1;
    mv += last * p.quantity * 1000;
    unreal += account.stockPnl(p);
    if (fin(x?.ref ?? NaN)) today += sg * (last - x!.ref) * p.quantity * 1000;
  }
  const st = [...s.settlements].sort((a, b) => a.T - b.T);
  el.innerHTML = `<div class="ct">證券帳戶<span class="ct-r">${s.sAccount ? esc(s.sAccount.broker_id + '-' + s.sAccount.account_id) : ''}</span></div>
    <div class="cm">${s.stkPos.length ? fmt(mv) : '—'}</div>
    <div class="kv2"><span>未實現損益</span><b class="${cls(unreal)}">${money(unreal)}</b></div>
    <div class="kv2"><span>今日損益</span><b class="${cls(today)}">${money(today)}</b></div>
    ${st.length ? `<div class="settle">${st.map((x) => `<div><span>${x.T === 0 ? '今日' : `T+${x.T}`}交割</span>
      <b class="${cls(x.amount)}">${money(x.amount)}</b></div>`).join('')}</div>` : ''}`;
}

// ───────── 期權部位表 ─────────
function renderFutPos(pcs: PosCalc[]) {
  const el = document.getElementById('ac-fpos')!;
  const s = account.state;
  const total = pcs.reduce((x, c) => x + (fin(c.pnl) ? c.pnl : 0), 0);
  el.innerHTML = `<div class="ct">期權部位<span class="ct-r">未實現 <b class="${cls(total)}">${money(total)}</b></span></div>
    ${pcs.length ? `<div class="tbl-wrap"><table class="grid"><thead><tr>
      <th>商品</th><th>方向</th><th class="r">口數</th><th class="r">成本</th><th class="r">現價</th><th class="r">損益</th>
      <th class="r">Delta</th><th class="r">IV</th><th class="r">到期</th></tr></thead><tbody>
      ${pcs.map((c) => `<tr>
        <td title="${esc(c.p.code)}"><b>${esc(posName(c.p.code))}</b>${account.mapped.has(c.p.code) ? '' : '<small class="muted"> 15秒</small>'}</td>
        <td class="${c.sgn > 0 ? 'up' : 'down'}">${c.sgn > 0 ? '買' : '賣'}</td>
        <td class="r">${c.p.quantity}</td><td class="r">${fmtP(c.p.price)}</td>
        <td class="r">${fmtP(c.last)}</td><td class="r b ${cls(c.pnl)}">${money(c.pnl)}</td>
        <td class="r">${fin(c.delta) ? sign(c.delta / 200, 2) : '—'}</td>
        <td class="r">${fin(c.iv) ? (c.iv * 100).toFixed(1) + '%' : ''}</td>
        <td class="r">${c.expiry ? `${c.expiry.label}<small class="muted"> ${Math.max(0, Math.ceil(c.T * 365))}天</small>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="muted">${s.errors.futPos ? '查詢失敗：' + esc(s.errors.futPos) : s.ready ? '目前沒有期權部位' : '查詢中…'}</div>`}`;
}

// ───────── 到期損益圖（SVG） ─────────
function renderPayoff(pcs: PosCalc[]) {
  const el = document.getElementById('ac-payoff')!;
  const legs = pcs.filter((c) => (c.kind === 'opt' && fin(c.K)) || c.kind === 'fut');
  if (!legs.length) { el.innerHTML = `<div class="muted heat-empty">${account.state.ready ? '沒有可繪製的期權部位' : '查詢中…'}</div>`; return; }
  const optF = legs.find((c) => fin(c.F))?.F;
  const center = fin(optF ?? NaN) ? optF! : hub.quotes.get(hub.futKey)?.last ?? NaN;
  if (!fin(center)) { el.innerHTML = '<div class="muted heat-empty">等待行情…</div>'; return; }
  const spread = Math.max(1200, ...legs.filter((c) => fin(c.K)).map((c) => Math.abs(c.K - center) * 1.6));
  const lo = center - spread, hi = center + spread, N = 120;
  const xs = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N);
  const atExpiry = (S: number) => legs.reduce((sum, c) => {
    const q = c.sgn * c.p.quantity * c.mult;
    if (c.kind === 'fut') return sum + q * (S - c.p.price);
    const intrinsic = Math.max(0, c.right === 'C' ? S - c.K : c.K - S);
    return sum + q * (intrinsic - c.p.price);
  }, 0);
  const now = (S: number) => legs.reduce((sum, c) => {
    const q = c.sgn * c.p.quantity * c.mult;
    if (c.kind === 'fut') return sum + q * (S - c.p.price);
    const F = c.F + (S - center);
    const v = fin(c.iv) ? bsPrice(F, c.K, c.T, c.iv, c.right!) : Math.max(0, c.right === 'C' ? F - c.K : c.K - F);
    return sum + q * (v - c.p.price);
  }, 0);
  const ye = xs.map(atExpiry), yn = xs.map(now);
  const ymin = Math.min(0, ...ye, ...yn), ymax = Math.max(0, ...ye, ...yn);
  const W = el.clientWidth || 400, H = el.clientHeight || 260, pl = 8, pr = 64, pt = 10, pb = 22;
  const X = (x: number) => pl + ((x - lo) / (hi - lo)) * (W - pl - pr);
  const Y = (y: number) => pt + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - pt - pb);
  const path = (ys: number[]) => ys.map((y, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(y).toFixed(1)}`).join('');
  // 損益兩平：到期曲線穿越 0 的位置
  const bes: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    if ((ye[i - 1] < 0) !== (ye[i] < 0)) bes.push(xs[i - 1] + ((0 - ye[i - 1]) / (ye[i] - ye[i - 1])) * (xs[i] - xs[i - 1]));
  }
  // 獲利區塊（到期曲線在 0 之上）上色
  const area = (positive: boolean) => {
    const zero = Y(0);
    return xs.map((x, i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${(positive ? Math.min(Y(ye[i]), zero) : Math.max(Y(ye[i]), zero)).toFixed(1)}`).join('')
      + `L${X(hi).toFixed(1)},${zero}L${X(lo).toFixed(1)},${zero}Z`;
  };
  const ticks = [ymin, 0, ymax].filter((v, i, a) => a.indexOf(v) === i);
  const fut = hub.quotes.get(hub.futKey)?.last ?? NaN;
  el.innerHTML = `<svg width="${W}" height="${H}" class="po">
    <path d="${area(true)}" fill="rgba(240,82,79,.12)"/><path d="${area(false)}" fill="rgba(34,176,125,.12)"/>
    <line x1="${pl}" x2="${W - pr}" y1="${Y(0)}" y2="${Y(0)}" class="po-zero"/>
    ${fin(fut) && fut > lo && fut < hi ? `<line x1="${X(fut)}" x2="${X(fut)}" y1="${pt}" y2="${H - pb}" class="po-now"/><text x="${X(fut) + 4}" y="${pt + 10}" class="po-t">現在 ${fmt(fut)}</text>` : ''}
    <path d="${path(yn)}" class="po-l-now"/><path d="${path(ye)}" class="po-l-exp"/>
    ${bes.map((b) => `<circle cx="${X(b)}" cy="${Y(0)}" r="4" class="po-be"/><text x="${X(b)}" y="${Y(0) + 16}" text-anchor="middle" class="po-t be">${fmt(b)}</text>`).join('')}
    ${ticks.map((v) => `<text x="${W - pr + 6}" y="${Y(v) + 4}" class="po-t">${v === 0 ? '0' : (v / 1e4).toFixed(1) + '萬'}</text>`).join('')}
    <text x="${pl}" y="${H - 6}" class="po-t">${fmt(lo)}</text><text x="${W - pr}" y="${H - 6}" text-anchor="end" class="po-t">${fmt(hi)}</text>
  </svg>`;
}

// ───────── 證券庫存 ─────────
function renderStkPos() {
  const el = document.getElementById('ac-spos')!;
  const s = account.state;
  const rows = s.stkPos.map((p) => {
    const x = hub.quotes.get(p.code);
    const last = x?.last ?? p.last_price, ref = x?.ref ?? NaN, sg = p.direction === 'Sell' ? -1 : 1;
    const mv = last * p.quantity * 1000, cost = p.price * p.quantity * 1000;
    const pnl = account.stockPnl(p);
    return { p, last, ref, mv, pnl, ret: cost ? (pnl / cost) * 100 : NaN, dayPct: (last / ref - 1) * 100,
      dayPnl: fin(ref) ? sg * (last - ref) * p.quantity * 1000 : NaN, flash: x?.flash ?? 0, dir: x?.dir ?? 0 };
  });
  const totalMv = rows.reduce((a, r) => a + (fin(r.mv) ? r.mv : 0), 0);
  const now = performance.now();
  el.innerHTML = `<div class="ct">證券庫存<span class="ct-r">${rows.length} 檔　市值 <b>${fmt(totalMv)}</b></span></div>
    ${!s.sAccount && s.ready ? '<div class="note">API Key 尚未綁定證券帳戶</div>' : rows.length ? `<div class="tbl-wrap"><table class="grid"><thead><tr>
      <th>股票</th><th class="r">張數</th><th class="r">成本</th><th class="r">現價</th><th class="r">今日漲跌</th><th class="r">今日損益</th>
      <th class="r">市值</th><th>佔比</th><th class="r">未實現損益</th><th class="r">報酬率</th></tr></thead><tbody>
      ${rows.sort((a, b) => b.mv - a.mv).map((r) => `<tr data-code="${esc(r.p.code)}" class="link">
        <td><b>${esc(account.nameOf(r.p.code))}</b> <small class="muted">${esc(r.p.code)}</small></td>
        <td class="r">${r.p.quantity}${r.p.direction === 'Sell' ? '<small class="muted"> 券</small>' : ''}</td>
        <td class="r">${fmtP(r.p.price)}</td>
        <td class="r b ${cls(r.dayPct)}${now - r.flash < 700 ? (r.dir > 0 ? ' fu' : ' fd') : ''}">${fmtP(r.last)}</td>
        <td class="r ${cls(r.dayPct)}">${fin(r.dayPct) ? sign(r.dayPct, 2) + '%' : '—'}</td>
        <td class="r ${cls(r.dayPnl)}">${money(r.dayPnl)}</td>
        <td class="r">${fmt(r.mv)}</td>
        <td class="share"><div class="sbar"><i style="width:${totalMv ? (r.mv / totalMv) * 100 : 0}%"></i></div><small>${totalMv ? ((r.mv / totalMv) * 100).toFixed(1) + '%' : ''}</small></td>
        <td class="r b ${cls(r.pnl)}">${money(r.pnl)}</td>
        <td class="r ${cls(r.ret)}">${fin(r.ret) ? sign(r.ret, 2) + '%' : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="muted">${s.errors.stkPos ? '查詢失敗：' + esc(s.errors.stkPos) : s.ready ? '目前沒有庫存' : '查詢中…'}</div>`}`;
}

// ───────── 已實現損益（自選期間） ─────────
let rlSeq = 0;
async function loadRealized() {
  const b = (document.getElementById('rl-b') as HTMLInputElement).value;
  const e = (document.getElementById('rl-e') as HTMLInputElement).value;
  const el = document.getElementById('ac-realized')!;
  if (!b || !e || b > e) { el.innerHTML = '<div class="muted">請選擇正確的起訖日期</div>'; return; }
  const seq = ++rlSeq;
  el.innerHTML = '<div class="muted">查詢中…</div>';
  try {
    if (!account.state.ready) await account.refresh();
    const rows = await account.queryRealized(b, e);
    if (seq !== rlSeq || !mounted) return;
    const byDay = new Map<string, number>();
    for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.pnl);
    const days = [...byDay.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    const sumF = rows.filter((r) => r.account === 'F').reduce((a, r) => a + r.pnl, 0);
    const sumS = rows.filter((r) => r.account === 'S').reduce((a, r) => a + r.pnl, 0);
    const win = days.filter((d) => d[1] > 0).length;
    const mx = Math.max(1, ...days.map((d) => Math.abs(d[1])));
    el.innerHTML = `<div class="rl-sum">
        <div><span>合計</span><b class="${cls(sumF + sumS)}">${money(sumF + sumS)}</b></div>
        <div><span>期權</span><b class="${cls(sumF)}">${money(sumF)}</b></div>
        <div><span>證券</span><b class="${cls(sumS)}">${money(sumS)}</b></div>
        <div><span>獲利天數</span><b>${win} / ${days.length}</b></div>
      </div>
      ${days.length ? `<div class="rl-bars">${days.map(([d, v]) => `<div class="rl-b" title="${d}　${money(v)}">
        <div class="rl-up">${v > 0 ? `<i style="height:${(v / mx) * 100}%"></i>` : ''}</div>
        <div class="rl-dn">${v < 0 ? `<i style="height:${(-v / mx) * 100}%"></i>` : ''}</div>
        <small>${+d.slice(8)}</small></div>`).join('')}</div>
      <details class="rl-detail"><summary>明細（${rows.length} 筆）</summary><div class="tbl-wrap"><table class="grid"><thead><tr>
        <th>日期</th><th>帳戶</th><th>商品</th><th class="r">數量</th><th class="r">損益</th></tr></thead><tbody>
        ${[...rows].reverse().map((r) => `<tr><td>${r.date}</td><td>${r.account === 'F' ? '期權' : '證券'}</td>
          <td>${esc(r.account === 'S' ? `${account.nameOf(r.code)} ${r.code}` : posName(r.code))}</td>
          <td class="r">${r.quantity}</td><td class="r b ${cls(r.pnl)}">${money(r.pnl)}</td></tr>`).join('')}
      </tbody></table></div></details>` : '<div class="muted">這段期間沒有已實現損益</div>'}`;
  } catch (err) {
    if (seq === rlSeq) el.innerHTML = `<div class="note">查詢失敗：${esc(String((err as Error)?.message ?? err))}</div>`;
  }
}

function setRange(r: string) {
  const t = tpeNow();
  const today = tpeToday();
  let begin = today;
  if (r === 'week') { const wd = (t.getUTCDay() + 6) % 7; begin = tpeToday(-wd); }
  if (r === 'month') begin = today.slice(0, 8) + '01';
  if (r === 'year') begin = today.slice(0, 5) + '01-01';
  (document.getElementById('rl-b') as HTMLInputElement).value = begin;
  (document.getElementById('rl-e') as HTMLInputElement).value = today;
  document.querySelectorAll<HTMLElement>('.rl-ctl button').forEach((b) => b.classList.toggle('on', b.dataset.r === r));
  loadRealized();
}

// ───────── 主迴圈 ─────────
function frame() {
  if (!mounted) return;
  if (dirty) {
    dirty = false;
    const pcs = calcPositions();
    renderMargin(); renderGreeks(pcs); renderStkSummary(); renderFutPos(pcs); renderPayoff(pcs); renderStkPos();
  }
  timer = setTimeout(() => requestAnimationFrame(frame), 400);
}

/** 期權部位所屬到期日的整條鏈快照（算合成期貨與 IV 用） */
function loadChainSnapshots() {
  const exps = new Set<Expiry>();
  for (const m of account.mapped.values()) if (m.expiry) exps.add(m.expiry);
  for (const e of exps) hub.loadSnapshots(e.list);
}

export const accountPage: Page = {
  id: 'account',
  title: '帳務',
  mount(el) {
    mounted = true;
    dirty = true;
    el.innerHTML = TEMPLATE;
    account.use(OWNER);
    cleanups.push(hub.on('change', () => { dirty = true; }));
    cleanups.push(account.on(() => { dirty = true; loadChainSnapshots(); }));
    const onResize = () => { dirty = true; };
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));
    const t = setInterval(loadChainSnapshots, 15_000);
    cleanups.push(() => clearInterval(t));
    el.querySelector('.rl-ctl')!.addEventListener('click', (ev) => {
      const r = (ev.target as HTMLElement).closest<HTMLElement>('button')?.dataset.r;
      if (r) setRange(r);
    });
    for (const id of ['rl-b', 'rl-e']) {
      document.getElementById(id)!.addEventListener('change', () => {
        document.querySelectorAll('.rl-ctl button').forEach((b) => b.classList.remove('on'));
        loadRealized();
      });
    }
    document.getElementById('ac-spos')!.addEventListener('click', (ev) => {
      const code = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-code]')?.dataset.code;
      if (code) location.hash = `#/stocks/${code}`;
    });
    setRange('month');
    frame();
  },
  unmount() {
    mounted = false;
    clearTimeout(timer);
    cleanups.splice(0).forEach((f) => f());
    account.unuse(OWNER);
    hub.releaseAll(OWNER);
  },
};
