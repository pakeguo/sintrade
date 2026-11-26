// 技術分析畫面：1 主圖（K 棒＋成交量＋疊加指標）＋ 2 副圖
// 指標設定在「⚙ 指標」獨立視窗編輯（比照報價頁的選股視窗），設定存 localStorage `mw.taCfg`
// 即時：update(bars) 只更新資料，不重建圖表、不動使用者的縮放位置
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { findInd, INDICATORS, type Line } from '../core/ta';
import { cssVar, esc, fin, fmtP, LS } from '../core/util';
import type { Bar } from '../types';

interface Pick { id: string; params: number[] }
interface Cfg { main: Pick[]; sub: [Pick, Pick] }
const DEF: Cfg = { main: [{ id: 'ma', params: [5, 10, 20, 60] }], sub: [{ id: 'macd', params: [12, 26, 9] }, { id: 'kd', params: [9, 3, 3] }] };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const paramsOf = (p: Pick) => { const d = findInd(p.id); return d ? d.params.map((x, i) => (fin(p.params[i]) ? p.params[i] : x.def)) : []; };
const short = (id: string) => findInd(id)?.name.split(' ')[0] ?? id;
const label = (p: Pick) => `${short(p.id)}(${paramsOf(p).join(',')})`;

type S = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
interface Pane { chart: IChartApi; series: S[] }

export class TAView {
  private cfg: Cfg = (() => { const c = LS.getJSON<Cfg>('taCfg', DEF); return c?.main && c?.sub?.length === 2 ? c : clone(DEF); })();
  private panes: Pane[] = [];
  private candle: ISeriesApi<'Candlestick'> | null = null;
  private vol: ISeriesApi<'Histogram'> | null = null;
  private bars: Bar[] = [];
  private minute = false;
  private ro: ResizeObserver;
  private modal: HTMLElement | null = null;
  private mTab: 'main' | 'sub0' | 'sub1' = 'main';

  constructor(private host: HTMLElement) {
    host.innerHTML = `
      <div class="ta-bar"><span id="ta-sum" class="ta-sum"></span></div>
      <div class="ta-panes">
        <div class="ta-pane main"><div class="ta-lgd" id="ta-l0"></div><div class="ta-c" id="ta-c0"></div></div>
        <div class="ta-pane"><div class="ta-lgd" id="ta-l1"></div><div class="ta-c" id="ta-c1"></div></div>
        <div class="ta-pane"><div class="ta-lgd" id="ta-l2"></div><div class="ta-c" id="ta-c2"></div></div>
      </div>`;
    this.ro = new ResizeObserver(() => this.panes.forEach((p, i) => {
      const el = host.querySelector<HTMLElement>(`#ta-c${i}`);
      if (el && el.clientWidth) p.chart.resize(el.clientWidth, el.clientHeight);
    }));
    this.ro.observe(host);
    this.renderSum();
  }

  private save() { LS.setJSON('taCfg', this.cfg); this.renderSum(); }
  private renderSum() {
    this.host.querySelector('#ta-sum')!.innerHTML =
      `<b>主圖</b> K＋量${this.cfg.main.map((p) => `・${esc(label(p))}`).join('')}　<b>副圖1</b> ${esc(label(this.cfg.sub[0]))}　<b>副圖2</b> ${esc(label(this.cfg.sub[1]))}`;
  }

  /** 換股票或週期：重建圖表並重設可視範圍 */
  setBars(bars: Bar[], minute: boolean) { this.bars = bars; this.minute = minute; this.build(); this.fill(true); }
  /** 即時更新：只更新資料 */
  update(bars: Bar[]) { this.bars = bars; this.fill(false); }

  private opts(el: HTMLElement, sub: boolean) {
    return {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderVisible: false, minimumWidth: 72 },
      timeScale: { borderVisible: false, timeVisible: this.minute, secondsVisible: false },
      crosshair: { mode: 0 },
      ...(sub ? { handleScroll: false, handleScale: false } : {}),
    } as const;
  }

  /** 依目前設定建立 3 個圖表與所有序列（不放資料） */
  private build() {
    this.panes.forEach((p) => p.chart.remove());
    this.panes = [];
    const up = cssVar('--up'), dn = cssVar('--down');
    const mk = (chart: IChartApi, l: Line): S => (l.type === 'hist'
      ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false })
      : chart.addSeries(LineSeries, {
        color: l.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        ...(l.type === 'dot' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}),
      }));
    const probe = this.bars.length ? this.bars : [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }];

    const el0 = this.host.querySelector<HTMLElement>('#ta-c0')!;
    const main = createChart(el0, this.opts(el0, false));
    this.candle = main.addSeries(CandlestickSeries, { upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn });
    this.vol = main.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    main.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const ms: S[] = [];
    for (const p of this.cfg.main) { const d = findInd(p.id); if (d) for (const l of d.calc(probe, paramsOf(p))) ms.push(mk(main, l)); }
    this.panes.push({ chart: main, series: ms });

    for (const i of [0, 1]) {
      const el = this.host.querySelector<HTMLElement>(`#ta-c${i + 1}`)!;
      const ch = createChart(el, this.opts(el, true));
      const p = this.cfg.sub[i], d = findInd(p.id);
      const ss = d ? d.calc(probe, paramsOf(p)).map((l) => mk(ch, l)) : [];
      for (const lv of d?.levels ?? []) ss[0]?.createPriceLine({ price: lv, color: 'rgba(139,149,163,.5)', lineStyle: LineStyle.Dashed, lineWidth: 1, title: '' });
      this.panes.push({ chart: ch, series: ss });
    }
    main.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r) this.panes.slice(1).forEach((p) => p.chart.timeScale().setVisibleLogicalRange(r)); });
  }

  /** 計算指標並放入資料；reset=true 時把可視範圍設到最近 120 根 */
  private fill(reset: boolean) {
    const b = this.bars;
    if (!this.panes.length || !this.candle) return;
    const T = (i: number) => b[i].t as UTCTimestamp;
    const up = cssVar('--up'), dn = cssVar('--down'), upA = cssVar('--up-a'), dnA = cssVar('--down-a');
    const put = (s: S, l: Line) => {
      if (l.type === 'hist') {
        (s as ISeriesApi<'Histogram'>).setData(l.data.map((v, i) => (fin(v)
          ? { time: T(i), value: v, color: l.name === '量' ? (b[i].c >= b[i].o ? upA : dnA) : v >= 0 ? up : dn } : { time: T(i) })));
      } else (s as ISeriesApi<'Line'>).setData(l.data.map((v, i) => (fin(v) ? { time: T(i), value: v } : { time: T(i) })));
    };
    const fmtv = (v: number) => (Math.abs(v) >= 1e6 ? (v / 1e4).toFixed(0) + '萬' : (v < 0 ? '−' : '') + fmtP(Math.abs(v)));
    const lgd = (i: number, title: string, lines: Line[]) => {
      this.host.querySelector(`#ta-l${i}`)!.innerHTML = `<b>${esc(title)}</b>` + lines.filter((l) => l.name !== '量').map((l) => {
        const v = [...l.data].reverse().find(fin);
        return `<span style="color:${l.color || 'var(--text)'}">${esc(l.name)} ${v === undefined ? '—' : fmtv(v)}</span>`;
      }).join('');
    };

    this.candle.setData(b.map((x) => ({ time: x.t as UTCTimestamp, open: x.o, high: x.h, low: x.l, close: x.c })));
    this.vol!.setData(b.map((x) => ({ time: x.t as UTCTimestamp, value: x.v, color: x.c >= x.o ? upA : dnA })));
    const mainLines: Line[] = [];
    let k = 0;
    for (const p of this.cfg.main) {
      const d = findInd(p.id); if (!d) continue;
      for (const l of b.length ? d.calc(b, paramsOf(p)) : []) { const s = this.panes[0].series[k++]; if (s) put(s, l); mainLines.push(l); }
    }
    lgd(0, b.length ? `收 ${fmtP(b[b.length - 1].c)}` : '主圖', mainLines);
    for (const i of [0, 1]) {
      const p = this.cfg.sub[i], d = findInd(p.id);
      const lines = d && b.length ? d.calc(b, paramsOf(p)) : [];
      lines.forEach((l, j) => { const s = this.panes[i + 1].series[j]; if (s) put(s, l); });
      lgd(i + 1, label(p), lines);
    }
    if (reset) {
      const n = b.length;
      this.panes[0].chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 2 });
    }
  }

  /** 設定改變：重建圖表，但盡量保留目前的可視範圍 */
  private applyCfg() {
    this.save();
    const r = this.panes[0]?.chart.timeScale().getVisibleLogicalRange();
    this.build(); this.fill(!r);
    if (r) this.panes[0].chart.timeScale().setVisibleLogicalRange(r);
    this.renderModal();
  }

  // ───────── 指標設定視窗 ─────────
  /** 由個股頁「技術分析」旁的 ⚙ 按鈕開啟 */
  openModal() {
    this.modal?.remove();
    const m = document.createElement('div');
    m.className = 'pk-modal-bg';
    m.innerHTML = `<div class="pk-modal ta-modal" role="dialog">
      <div class="pk-head"><b>技術指標</b>
        <div class="seg" id="tm-tabs"><button data-t="main">主圖疊加</button><button data-t="sub0">副圖 1</button><button data-t="sub1">副圖 2</button></div>
        <button id="tm-reset" class="pk-to2">恢復預設</button><button class="pk-x" title="關閉（Esc）">✕</button></div>
      <div id="tm-body" class="pk-body"></div></div>`;
    document.body.append(m);
    this.modal = m;
    m.addEventListener('click', (e) => this.onModalClick(e));
    m.addEventListener('change', (e) => this.onModalChange(e));
    document.addEventListener('keydown', this.onKey);
    this.renderModal();
  }
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.closeModal(); };
  private closeModal() { this.modal?.remove(); this.modal = null; document.removeEventListener('keydown', this.onKey); }

  private renderModal() {
    const m = this.modal; if (!m) return;
    m.querySelectorAll<HTMLElement>('#tm-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === this.mTab));
    const pane = this.mTab === 'main' ? 'main' : 'sub';
    const list = INDICATORS.filter((d) => d.pane === pane);
    const subIdx = this.mTab === 'sub0' ? 0 : 1;
    const active = (id: string) => (pane === 'main' ? this.cfg.main.find((p) => p.id === id) : this.cfg.sub[subIdx].id === id ? this.cfg.sub[subIdx] : undefined);
    m.querySelector('#tm-body')!.innerHTML = `<div class="tm-list">
      <div class="muted tm-hint">${pane === 'main' ? '可同時疊加多個指標（主圖固定含 K 棒與成交量）' : `副圖 ${subIdx + 1} 選一個指標`}・參數改完按 Enter 或移開即套用</div>
      ${list.map((d) => { const a = active(d.id); const ps = a ? paramsOf(a) : d.params.map((x) => x.def);
        return `<div class="tm-row${a ? ' on' : ''}" data-id="${d.id}">
          <label class="tm-pick"><input type="${pane === 'main' ? 'checkbox' : 'radio'}" name="tm-pick" ${a ? 'checked' : ''}> <b>${esc(d.name)}</b></label>
          <span class="tm-params">${d.params.map((x, i) => `<label>${esc(x.label)} <input type="number" step="any" data-pi="${i}" value="${ps[i]}" ${a ? '' : 'disabled'}></label>`).join('')}</span>
        </div>`; }).join('')}</div>`;
  }

  private onModalClick(e: Event) {
    const t = e.target as HTMLElement, m = this.modal!;
    if (t === m || t.closest('.pk-x')) { this.closeModal(); return; }
    const tab = t.closest<HTMLElement>('#tm-tabs [data-t]')?.dataset.t as TAView['mTab'] | undefined;
    if (tab) { this.mTab = tab; this.renderModal(); return; }
    if (t.id === 'tm-reset') { this.cfg = clone(DEF); this.applyCfg(); }
  }

  private onModalChange(e: Event) {
    const inp = e.target as HTMLInputElement;
    const row = inp.closest<HTMLElement>('.tm-row'); if (!row) return;
    const id = row.dataset.id!, d = findInd(id)!;
    const subIdx = this.mTab === 'sub0' ? 0 : 1;
    if (inp.name === 'tm-pick') {
      if (this.mTab === 'main') {
        if (inp.checked) this.cfg.main.push({ id, params: d.params.map((x) => x.def) });
        else this.cfg.main = this.cfg.main.filter((p) => p.id !== id);
      } else this.cfg.sub[subIdx] = { id, params: d.params.map((x) => x.def) };
    } else if (inp.dataset.pi != null) {
      const p = this.mTab === 'main' ? this.cfg.main.find((x) => x.id === id) : this.cfg.sub[subIdx];
      const v = Number(inp.value);
      if (!p || !fin(v)) return;
      p.params = paramsOf(p); p.params[Number(inp.dataset.pi)] = v;
    } else return;
    this.applyCfg();
  }

  destroy() {
    this.closeModal();
    this.ro.disconnect();
    this.panes.forEach((p) => p.chart.remove());
    this.panes = [];
  }
}
