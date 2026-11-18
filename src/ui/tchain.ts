// 精簡版 T 字報價（商品頁右側）：結算日小卡、關鍵指標列、價平 ±N 檔即時報價
// 計算與期權頁共用 core/optchain.ts；訂閱一律透過 hub.acquire/release（owner = 'tchain'）
import { hub } from '../core/hub';
import { openTA } from '../core/nav';
import { computeMetrics, type Expiry, loadTxoExpiries, pcrLabel, type Row, rowsOf, synthetic } from '../core/optchain';
import { cls, esc, fin, fmt, fmtP, fmtVol, isLive, LS, sign } from '../core/util';
import { yearsToExpiry } from '../bs';
import type { OptContract } from '../types';

const OWNER = 'tchain';

export class TChain {
  private expiries: Expiry[] = [];
  private cur: Expiry | null = null;
  private visible: OptContract[] = [];
  private center = NaN;
  private range = Number(LS.get('pcRange') ?? 8);
  private dirty = true;
  private alive = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private offs: (() => void)[] = [];

  constructor(private host: HTMLElement) {
    host.innerHTML = `
      <div class="tc-chips" id="tc-chips"><span class="muted">載入結算日…</span></div>
      <div class="tc-kpi" id="tc-kpi"></div>
      <div class="tc-wrap"><table class="chain tc"><thead>
        <tr class="sidehead"><th colspan="3" class="up">買權 CALL</th><th></th><th colspan="3" class="down">賣權 PUT</th></tr>
        <tr><th>成交量</th><th>漲跌</th><th>成交</th><th>履約價</th><th>成交</th><th>漲跌</th><th>成交量</th></tr>
      </thead><tbody id="tc-body"><tr><td colspan="7" class="empty">載入中…</td></tr></tbody></table></div>
      <div class="tc-foot"><span>檔數 <select id="tc-range"><option>6</option><option>8</option><option>10</option><option>12</option></select></span>
        <button id="tc-center">置中價平</button><span class="muted">點價格看技術分析</span></div>`;
    (host.querySelector('#tc-range') as HTMLSelectElement).value = String(this.range);
    host.querySelector('#tc-range')!.addEventListener('change', (e) => {
      this.range = Number((e.target as HTMLSelectElement).value); LS.set('pcRange', String(this.range)); this.recenter(true);
    });
    host.querySelector('#tc-center')!.addEventListener('click', () => this.recenter(true));
    host.querySelector('#tc-chips')!.addEventListener('click', (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
      const ex = this.expiries.find((x) => x.key === key);
      if (ex && ex !== this.cur) this.select(ex);
    });
    host.querySelector('#tc-body')!.addEventListener('click', (e) => {
      const code = (e.target as HTMLElement).closest<HTMLElement>('[data-code]')?.dataset.code;
      const o = this.cur?.list.find((x) => x.code === code);
      if (o) openTA(o);
    });
    this.offs.push(hub.on('change', () => { this.dirty = true; }));
    this.intervals.push(setInterval(() => { if (this.cur) hub.loadSnapshots(this.cur.list); }, 15_000));
    this.intervals.push(setInterval(() => this.roll(), 60_000));
    this.load();
    this.frame();
  }

  private async load() {
    for (let delay = 2000; this.alive; delay = Math.min(delay * 1.5, 30_000)) {
      try {
        this.expiries = await loadTxoExpiries();
        if (this.expiries.length) break;
      } catch (e) { console.warn('tchain', e); }
      this.host.querySelector('#tc-chips')!.innerHTML = '<span class="muted">選擇權商品檔尚未就緒，自動重試中…</span>';
      await new Promise((r) => setTimeout(r, delay));
    }
    if (!this.alive) return;
    const saved = LS.get('pcExpiry');
    await this.select(this.expiries.find((e) => e.key === saved) ?? this.expiries[0]);
  }

  /** 結算日過了 13:30 → 重新載入並切到下一個 */
  private async roll() {
    if (!this.cur || isLive(this.cur.date)) return;
    this.expiries = await loadTxoExpiries().catch(() => this.expiries);
    await this.select(this.expiries[0]);
  }

  private async select(e: Expiry | undefined) {
    if (!e || !this.alive) return;
    this.cur = e;
    LS.set('pcExpiry', e.key);
    this.center = NaN;
    this.renderChips();
    await hub.loadSnapshots(e.list);
    this.recenter(true);
  }

  private renderChips() {
    this.host.querySelector('#tc-chips')!.innerHTML = this.expiries.map((e) => {
      const days = Math.ceil(yearsToExpiry(e.date) * 365);
      return `<button class="tc-chip${e === this.cur ? ' on' : ''}" data-key="${e.key}">
        <b>${e.label}</b><span>${e.kind}</span><small>${days <= 1 ? '今明' : days + '天'}</small></button>`;
    }).join('');
  }

  private rows(): Row[] { return this.cur ? rowsOf(this.cur) : []; }

  private recenter(force: boolean) {
    if (!this.cur) return;
    const all = this.rows();
    const F = synthetic(all);
    if (!all.length || !fin(F)) return;
    let i = all.findIndex((r) => r.k >= F);
    if (i < 0) i = all.length - 1;
    if (!force && fin(this.center)) {
      const ci = all.findIndex((r) => r.k === this.center);
      if (Math.abs(ci - i) < 3) return;
    }
    this.center = all[i].k;
    const next = all.slice(Math.max(0, i - this.range), i + this.range + 1).flatMap((r) => [r.c, r.p].filter(Boolean) as OptContract[]);
    const want = new Set(next.map((o) => o.code));
    for (const o of this.visible) if (!want.has(o.code)) hub.release(OWNER, o, ['Tick', 'BidAsk']);
    for (const o of next) hub.acquire(OWNER, o, ['Tick', 'BidAsk']);
    this.visible = next;
    this.dirty = true;
  }

  private frame = () => {
    if (!this.alive) return;
    if (this.dirty && this.cur) {
      this.dirty = false;
      this.render();
    }
    this.timer = setTimeout(() => requestAnimationFrame(this.frame), 250);
  };

  private lastRecenter = 0;
  private render() {
    const m = computeMetrics(this.cur);
    if (performance.now() - this.lastRecenter > 3000) { this.lastRecenter = performance.now(); this.recenter(false); }
    const hrs = m.T * 365 * 24;
    const left = hrs >= 24 ? `${Math.floor(hrs / 24)}天${Math.floor(hrs % 24)}時` : `${Math.floor(hrs)}時${Math.floor((hrs * 60) % 60)}分`;
    this.host.querySelector('#tc-kpi')!.innerHTML = `
      <div><span>剩餘</span><b>${left}</b></div>
      <div><span>合成期貨</span><b>${fmt(m.F, 1)}</b></div>
      <div><span>預期區間</span><b class="accent">${fin(m.straddle) ? '±' + fmt(m.straddle) : '—'}</b></div>
      <div><span>價平 IV</span><b>${fin(m.atmIV) ? (m.atmIV * 100).toFixed(1) + '%' : '—'}</b></div>
      <div><span>P/C</span><b>${fin(m.pcr) ? m.pcr.toFixed(2) : '—'}</b><small>${pcrLabel(m.pcr)}</small></div>
      <div><span>壓／撐</span><b><span class="up">${m.maxCall ? fmt(m.maxCall.k) : '—'}</span>/<span class="down">${m.maxPut ? fmt(m.maxPut.k) : '—'}</span></b></div>`;
    const vset = new Set(this.visible.map((o) => o.code));
    const rs = this.rows().filter((r) => (r.c && vset.has(r.c.code)) || (r.p && vset.has(r.p.code)));
    const maxV = Math.max(1, ...rs.flatMap((r) => [r.c, r.p].map((o) => (o ? hub.quotes.get(o.code)?.vol ?? 0 : 0))));
    const lo = m.F - m.straddle, hi = m.F + m.straddle;
    const now = performance.now();
    const cell = (o: OptContract | undefined, right: 'C' | 'P') => {
      if (!o) return '<td></td><td></td><td></td>';
      const x = hub.quotes.get(o.code);
      const v = x?.vol ?? 0, last = x?.last ?? NaN, ch = last - (x?.ref ?? NaN);
      const fl = x && now - x.flash < 700 ? (x.dir > 0 ? ' fu' : ' fd') : '';
      const wall = (right === 'C' ? m.maxCall : m.maxPut)?.k === o.strike ? ' wall' : '';
      const cells = [
        `<td class="vol ${right}${wall}"><i style="width:${(v / maxV) * 100}%"></i><span>${fmtVol(v)}</span></td>`,
        `<td class="chg ${cls(ch)}">${sign(ch, Math.abs(ch) < 10 && ch % 1 ? 1 : 0)}</td>`,
        `<td class="px ${cls(ch)}${fl}" data-code="${esc(o.code)}" data-side="${right}">${fmtP(last)}</td>`,
      ];
      return (right === 'C' ? cells : cells.reverse()).join('');
    };
    let html = '', marker = false;
    const fl = () => `<tr class="fline"><td colspan="3"></td><td class="fk">◆ ${fmt(m.F, 1)}</td><td colspan="3"></td></tr>`;
    for (const r of rs) {
      if (!marker && fin(m.F) && r.k > m.F) { html += fl(); marker = true; }
      const atm = m.atm?.k === r.k, band = fin(m.straddle) && r.k >= lo && r.k <= hi;
      const itmC = fin(m.F) && r.k < m.F, itmP = fin(m.F) && r.k > m.F;
      html += `<tr class="${atm ? 'atm' : ''}${band ? ' band' : ''}">`
        + cell(r.c, 'C').replace(/<td/g, `<td${itmC ? ' data-itm="1"' : ''}`)
        + `<td class="k">${fmt(r.k)}</td>`
        + cell(r.p, 'P').replace(/<td/g, `<td${itmP ? ' data-itm="1"' : ''}`) + '</tr>';
    }
    if (!marker && fin(m.F)) html += fl();
    this.host.querySelector('#tc-body')!.innerHTML = html || '<tr><td colspan="7" class="empty">載入中…</td></tr>';
  }

  destroy() {
    this.alive = false;
    clearTimeout(this.timer);
    this.intervals.forEach(clearInterval);
    this.offs.forEach((f) => f());
    hub.releaseAll(OWNER);
  }
}
