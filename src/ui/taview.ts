// 技術分析畫面：1 主圖（K 棒＋成交量＋疊加指標）＋ 2 副圖，指標與參數可自訂（設定存 localStorage）
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
const paramsOf = (p: Pick) => { const d = findInd(p.id); return d ? d.params.map((x, i) => (fin(p.params[i]) ? p.params[i] : x.def)) : []; };
const label = (p: Pick) => `${findInd(p.id)?.name.split(' ')[0] ?? p.id}(${paramsOf(p).join(',')})`;

export class TAView {
  private cfg: Cfg = LS.getJSON<Cfg>('taCfg', DEF);
  private charts: IChartApi[] = [];
  private bars: Bar[] = [];
  private minute = false;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement) {
    host.innerHTML = `
      <div class="ta-bar" id="ta-bar"></div>
      <div class="ta-panes">
        <div class="ta-pane main"><div class="ta-lgd" id="ta-l0"></div><div class="ta-c" id="ta-c0"></div></div>
        <div class="ta-pane"><div class="ta-lgd" id="ta-l1"></div><div class="ta-c" id="ta-c1"></div></div>
        <div class="ta-pane"><div class="ta-lgd" id="ta-l2"></div><div class="ta-c" id="ta-c2"></div></div>
      </div>`;
    host.querySelector('#ta-bar')!.addEventListener('click', (e) => this.onBar(e));
    host.querySelector('#ta-bar')!.addEventListener('change', (e) => this.onChange(e));
    this.ro = new ResizeObserver(() => this.charts.forEach((c, i) => {
      const el = host.querySelector<HTMLElement>(`#ta-c${i}`);
      if (el && el.clientWidth) c.resize(el.clientWidth, el.clientHeight);
    }));
    this.ro.observe(host);
    this.renderBar();
  }

  private save() { LS.setJSON('taCfg', this.cfg); }

  private renderBar() {
    const mains = INDICATORS.filter((d) => d.pane === 'main');
    const subs = INDICATORS.filter((d) => d.pane === 'sub');
    const chip = (p: Pick, where: string) => `<span class="ta-chip">${esc(label(p))}
      <button data-edit="${where}" title="修改參數">✎</button>${where.startsWith('m') ? `<button data-del="${where}" title="移除">×</button>` : ''}</span>`;
    this.host.querySelector('#ta-bar')!.innerHTML = `
      <span class="ta-grp"><b>主圖</b>${this.cfg.main.map((p, i) => chip(p, `m${i}`)).join('')}
        <select id="ta-addmain"><option value="">＋ 疊加指標</option>${mains.filter((d) => !this.cfg.main.some((p) => p.id === d.id)).map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select>
        <small class="muted">（含成交量）</small></span>
      ${[0, 1].map((i) => `<span class="ta-grp"><b>副圖${i + 1}</b>
        <select data-sub="${i}">${subs.map((d) => `<option value="${d.id}"${d.id === this.cfg.sub[i].id ? ' selected' : ''}>${d.name}</option>`).join('')}</select>
        ${chip(this.cfg.sub[i], `s${i}`)}</span>`).join('')}
      <button id="ta-reset" class="zoom-reset" title="恢復預設指標">預設</button>`;
  }

  private target(where: string): Pick | undefined {
    return where[0] === 'm' ? this.cfg.main[Number(where.slice(1))] : this.cfg.sub[Number(where.slice(1))];
  }

  private onBar(e: Event) {
    const t = e.target as HTMLElement;
    const edit = t.closest<HTMLElement>('[data-edit]')?.dataset.edit;
    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (t.id === 'ta-reset') { this.cfg = JSON.parse(JSON.stringify(DEF)); }
    else if (del) { this.cfg.main.splice(Number(del.slice(1)), 1); }
    else if (edit) {
      const p = this.target(edit); const d = p && findInd(p.id);
      if (!p || !d) return;
      const ans = prompt(`${d.name} 參數（${d.params.map((x) => x.label).join('、')}），以逗號分隔：`, paramsOf(p).join(','));
      if (ans == null) return;
      const v = ans.split(/[,，\s]+/).map(Number);
      if (v.some((x) => !fin(x))) { alert('參數要是數字'); return; }
      p.params = v;
    } else return;
    this.save(); this.renderBar(); this.draw();
  }

  private onChange(e: Event) {
    const t = e.target as HTMLSelectElement;
    if (t.id === 'ta-addmain' && t.value) {
      const d = findInd(t.value)!;
      this.cfg.main.push({ id: d.id, params: d.params.map((x) => x.def) });
    } else if (t.dataset.sub) {
      const d = findInd(t.value)!;
      this.cfg.sub[Number(t.dataset.sub)] = { id: d.id, params: d.params.map((x) => x.def) };
    } else return;
    this.save(); this.renderBar(); this.draw();
  }

  /** 載入 K 棒（週期由個股頁的週期列決定） */
  setBars(bars: Bar[], minute: boolean) { this.bars = bars; this.minute = minute; this.draw(); }

  private opts() {
    return {
      autoSize: false,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderVisible: false, minimumWidth: 72 },
      timeScale: { borderVisible: false, timeVisible: this.minute, secondsVisible: false },
      crosshair: { mode: 0 },
    } as const;
  }

  private draw() {
    this.charts.forEach((c) => c.remove());
    this.charts = [];
    const b = this.bars;
    const T = (i: number) => b[i].t as UTCTimestamp;
    const up = cssVar('--up'), dn = cssVar('--down');
    const series = (chart: IChartApi, l: Line, scaleId?: string) => {
      const pts = l.data.map((v, i) => (fin(v) ? { time: T(i), value: v } : { time: T(i) }));
      if (l.type === 'hist') {
        const s = chart.addSeries(HistogramSeries, { priceScaleId: scaleId, priceLineVisible: false, lastValueVisible: false });
        s.setData(l.data.map((v, i) => (fin(v) ? { time: T(i), value: v, color: l.name === '量' ? (b[i].c >= b[i].o ? cssVar('--up-a') : cssVar('--down-a')) : v >= 0 ? up : dn } : { time: T(i) })));
        return s;
      }
      const s = chart.addSeries(LineSeries, {
        priceScaleId: scaleId, color: l.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        ...(l.type === 'dot' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}),
      });
      s.setData(pts);
      return s;
    };
    const lgd = (i: number, title: string, lines: Line[]) => {
      this.host.querySelector(`#ta-l${i}`)!.innerHTML = `<b>${esc(title)}</b>` + lines.filter((l) => l.name !== '量').map((l) => {
        const v = [...l.data].reverse().find(fin);
        return `<span style="color:${l.color || 'var(--text)'}">${esc(l.name)} ${v === undefined ? '—' : Math.abs(v) >= 1e6 ? (v / 1e4).toFixed(0) + '萬' : fmtP(Math.abs(v)) === fmtP(v) ? fmtP(v) : '−' + fmtP(-v)}</span>`;
      }).join('');
    };

    // 主圖：K 棒＋成交量＋疊加指標
    const el0 = this.host.querySelector<HTMLElement>('#ta-c0')!;
    const main = createChart(el0, { ...this.opts(), width: el0.clientWidth, height: el0.clientHeight });
    const cs = main.addSeries(CandlestickSeries, { upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn });
    cs.setData(b.map((x) => ({ time: x.t as UTCTimestamp, open: x.o, high: x.h, low: x.l, close: x.c })));
    const vol = main.addSeries(HistogramSeries, { priceScaleId: 'v', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    vol.setData(b.map((x) => ({ time: x.t as UTCTimestamp, value: x.v, color: x.c >= x.o ? cssVar('--up-a') : cssVar('--down-a') })));
    main.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const mainLines: Line[] = [];
    for (const p of this.cfg.main) {
      const d = findInd(p.id); if (!d || !b.length) continue;
      for (const l of d.calc(b, paramsOf(p))) { series(main, l); mainLines.push(l); }
    }
    lgd(0, b.length ? `收 ${fmtP(b[b.length - 1].c)}` : '主圖', mainLines);
    this.charts.push(main);

    // 副圖 1、2
    for (const i of [0, 1]) {
      const el = this.host.querySelector<HTMLElement>(`#ta-c${i + 1}`)!;
      const ch = createChart(el, { ...this.opts(), width: el.clientWidth, height: el.clientHeight, handleScroll: false, handleScale: false });
      const p = this.cfg.sub[i], d = findInd(p.id);
      const lines = d && b.length ? d.calc(b, paramsOf(p)) : [];
      let first: ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | null = null;
      for (const l of lines) { const s = series(ch, l); first ??= s; }
      for (const lv of d?.levels ?? []) first?.createPriceLine({ price: lv, color: 'rgba(139,149,163,.5)', lineStyle: LineStyle.Dashed, lineWidth: 1, title: '' });
      lgd(i + 1, label(p), lines);
      this.charts.push(ch);
    }
    // 主圖捲動／縮放 → 副圖同步
    main.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r) this.charts.slice(1).forEach((c) => c.timeScale().setVisibleLogicalRange(r)); });
    const n = b.length;
    main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 2 });
  }

  destroy() {
    this.ro.disconnect();
    this.charts.forEach((c) => c.remove());
    this.charts = [];
  }
}
