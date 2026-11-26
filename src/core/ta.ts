// 技術指標庫（技術分析畫面用）：主圖疊加指標＋副圖指標，參數皆可自訂
// 每個指標回傳若干條線／柱，數值陣列與 K 棒一一對應（不足期數為 NaN）
import type { Bar } from '../types';

export interface Line { name: string; color: string; data: number[]; type?: 'line' | 'hist' | 'dot'; levels?: number[] }
export interface IndicatorDef {
  id: string; name: string; pane: 'main' | 'sub';
  params: { label: string; def: number }[];
  levels?: number[];                       // 副圖參考水平線（例：RSI 30/70）
  calc(b: Bar[], p: number[]): Line[];
}

const NaNs = (n: number) => new Array<number>(n).fill(NaN);
const C = ['#f5b94a', '#8fb3ff', '#d17cff', '#5fd3c6', '#ff8a65', '#c9d1d9'];

export function sma(v: number[], n: number): number[] {
  const o = NaNs(v.length); let s = 0, k = 0;
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(v[i])) { s += v[i]; k++; }
    if (i >= n && Number.isFinite(v[i - n])) { s -= v[i - n]; k--; }
    if (i >= n - 1 && k === n) o[i] = s / n;
  }
  return o;
}
export function ema(v: number[], n: number): number[] {
  const o = NaNs(v.length), a = 2 / (n + 1); let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    prev = Number.isFinite(prev) ? prev + a * (v[i] - prev) : v[i];
    o[i] = prev;
  }
  return o;
}
/** Wilder 平滑（RSI、ATR、DMI 用） */
function rma(v: number[], n: number): number[] {
  const o = NaNs(v.length); let prev = NaN, s = 0, k = 0;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    if (!Number.isFinite(prev)) { s += v[i]; k++; if (k === n) { prev = s / n; o[i] = prev; } continue; }
    prev = (prev * (n - 1) + v[i]) / n; o[i] = prev;
  }
  return o;
}
const stdev = (v: number[], n: number, m: number[]) => v.map((_, i) => {
  if (i < n - 1 || !Number.isFinite(m[i])) return NaN;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2; return Math.sqrt(s / n);
});
const hh = (v: number[], n: number) => v.map((_, i) => (i < n - 1 ? NaN : Math.max(...v.slice(i - n + 1, i + 1))));
const ll = (v: number[], n: number) => v.map((_, i) => (i < n - 1 ? NaN : Math.min(...v.slice(i - n + 1, i + 1))));
const sumN = (v: number[], n: number) => v.map((_, i) => { if (i < n - 1) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += v[j]; return s; });
const cl = (b: Bar[]) => b.map((x) => x.c);
const trueRange = (b: Bar[]) => b.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c))));

export const INDICATORS: IndicatorDef[] = [
  // ── 主圖 ──
  { id: 'ma', name: '移動平均 MA', pane: 'main', // 台股慣例：5 週線、10 雙週、20 月線、60 季線、120 半年線、240 年線；參數設 0 可隱藏該條
    params: [{ label: 'MA1', def: 5 }, { label: 'MA2', def: 10 }, { label: 'MA3', def: 20 }, { label: '季', def: 60 }, { label: '半年', def: 120 }, { label: '年', def: 240 }],
    calc: (b, p) => p.filter((n) => n > 0).map((n, i) => ({ name: `MA${n}`, color: C[i % C.length], data: sma(cl(b), n) })) },
  { id: 'ema', name: '指數平均 EMA', pane: 'main', params: [{ label: 'EMA1', def: 12 }, { label: 'EMA2', def: 26 }],
    calc: (b, p) => p.filter((n) => n > 0).map((n, i) => ({ name: `EMA${n}`, color: C[(i + 2) % C.length], data: ema(cl(b), n) })) },
  { id: 'boll', name: '布林通道 BOLL', pane: 'main', params: [{ label: '週期', def: 20 }, { label: '倍數', def: 2 }],
    calc: (b, [n, k]) => { const m = sma(cl(b), n), s = stdev(cl(b), n, m);
      return [{ name: '上軌', color: '#8b95a3', data: m.map((x, i) => x + k * s[i]) }, { name: '中軌', color: '#f5b94a', data: m }, { name: '下軌', color: '#8b95a3', data: m.map((x, i) => x - k * s[i]) }]; } },
  { id: 'env', name: '包絡線 ENV', pane: 'main', params: [{ label: '週期', def: 20 }, { label: '%', def: 5 }],
    calc: (b, [n, pct]) => { const m = sma(cl(b), n); return [{ name: '上', color: '#8fb3ff', data: m.map((x) => x * (1 + pct / 100)) }, { name: '下', color: '#8fb3ff', data: m.map((x) => x * (1 - pct / 100)) }]; } },
  { id: 'sar', name: '拋物線 SAR', pane: 'main', params: [{ label: '加速', def: 0.02 }, { label: '上限', def: 0.2 }],
    calc: (b, [step, max]) => {
      const o = NaNs(b.length); if (b.length < 2) return [{ name: 'SAR', color: '#d17cff', data: o, type: 'dot' }];
      let up = b[1].c >= b[0].c, af = step, ep = up ? b[0].h : b[0].l, sar = up ? b[0].l : b[0].h;
      for (let i = 1; i < b.length; i++) {
        sar = sar + af * (ep - sar);
        if (up) { sar = Math.min(sar, b[i - 1].l, i > 1 ? b[i - 2].l : b[i - 1].l); if (b[i].l < sar) { up = false; sar = ep; ep = b[i].l; af = step; } else if (b[i].h > ep) { ep = b[i].h; af = Math.min(max, af + step); } }
        else { sar = Math.max(sar, b[i - 1].h, i > 1 ? b[i - 2].h : b[i - 1].h); if (b[i].h > sar) { up = true; sar = ep; ep = b[i].h; af = step; } else if (b[i].l < ep) { ep = b[i].l; af = Math.min(max, af + step); } }
        o[i] = sar;
      }
      return [{ name: 'SAR', color: '#d17cff', data: o, type: 'dot' }]; } },
  { id: 'ichi', name: '一目均衡表', pane: 'main', params: [{ label: '轉換', def: 9 }, { label: '基準', def: 26 }, { label: '先行', def: 52 }],
    calc: (b, [a, k, s]) => { const H = b.map((x) => x.h), L = b.map((x) => x.l);
      const mid = (n: number) => hh(H, n).map((h, i) => (h + ll(L, n)[i]) / 2);
      const conv = mid(a), base = mid(k), spanB = mid(s);
      const spanA = conv.map((x, i) => (x + base[i]) / 2);
      const shift = (v: number[]) => v.map((_, i) => (i - k + 1 >= 0 ? v[i - k + 1] : NaN));
      return [{ name: '轉換線', color: '#8fb3ff', data: conv }, { name: '基準線', color: '#f5b94a', data: base },
        { name: '先行A', color: 'rgba(240,82,79,.7)', data: shift(spanA) }, { name: '先行B', color: 'rgba(34,176,125,.7)', data: shift(spanB) }]; } },
  { id: 'vwapc', name: '累積均價 AVG', pane: 'main', params: [{ label: '週期', def: 20 }],
    calc: (b, [n]) => { const pv = sumN(b.map((x) => ((x.h + x.l + x.c) / 3) * x.v), n), v = sumN(b.map((x) => x.v), n);
      return [{ name: `均價${n}`, color: '#5fd3c6', data: pv.map((x, i) => x / v[i]) }]; } },

  // ── 副圖 ──
  { id: 'vol', name: '成交量 VOL', pane: 'sub', params: [{ label: '均量1', def: 5 }, { label: '均量2', def: 20 }],
    calc: (b, [a, c]) => [{ name: '量', color: '', data: b.map((x) => x.v), type: 'hist' },
      { name: `MV${a}`, color: C[0], data: sma(b.map((x) => x.v), a) }, { name: `MV${c}`, color: C[1], data: sma(b.map((x) => x.v), c) }] },
  { id: 'macd', name: 'MACD', pane: 'sub', params: [{ label: '快', def: 12 }, { label: '慢', def: 26 }, { label: '訊號', def: 9 }],
    calc: (b, [f, s, g]) => { const dif = ema(cl(b), f).map((x, i) => x - ema(cl(b), s)[i]); const dea = ema(dif, g);
      return [{ name: 'OSC', color: '', data: dif.map((x, i) => (x - dea[i])), type: 'hist' }, { name: 'DIF', color: C[0], data: dif }, { name: 'MACD', color: C[1], data: dea }]; } },
  { id: 'kd', name: 'KD 隨機指標', pane: 'sub', params: [{ label: 'RSV', def: 9 }, { label: 'K', def: 3 }, { label: 'D', def: 3 }], levels: [20, 80],
    calc: (b, [n, kp, dp]) => { const H = hh(b.map((x) => x.h), n), L = ll(b.map((x) => x.l), n);
      const K = NaNs(b.length), D = NaNs(b.length); let k = 50, d = 50;
      b.forEach((x, i) => { if (!Number.isFinite(H[i])) return; const rsv = H[i] === L[i] ? 50 : ((x.c - L[i]) / (H[i] - L[i])) * 100;
        k = (k * (kp - 1) + rsv) / kp; d = (d * (dp - 1) + k) / dp; K[i] = k; D[i] = d; });
      return [{ name: 'K', color: C[0], data: K }, { name: 'D', color: C[1], data: D }]; } },
  { id: 'rsi', name: 'RSI 相對強弱', pane: 'sub', params: [{ label: 'RSI1', def: 6 }, { label: 'RSI2', def: 12 }], levels: [30, 70],
    calc: (b, p) => p.filter((n) => n > 0).map((n, i) => {
      const ch = cl(b).map((x, j, a) => (j ? x - a[j - 1] : 0));
      const up = rma(ch.map((x) => Math.max(x, 0)), n), dn = rma(ch.map((x) => Math.max(-x, 0)), n);
      return { name: `RSI${n}`, color: C[i], data: up.map((u, j) => (u + dn[j] ? (100 * u) / (u + dn[j]) : 50)) }; }) },
  { id: 'dmi', name: 'DMI 趨向指標', pane: 'sub', params: [{ label: '週期', def: 14 }],
    calc: (b, [n]) => { const pdm = b.map((x, i) => { if (!i) return 0; const u = x.h - b[i - 1].h, d = b[i - 1].l - x.l; return u > d && u > 0 ? u : 0; });
      const mdm = b.map((x, i) => { if (!i) return 0; const u = x.h - b[i - 1].h, d = b[i - 1].l - x.l; return d > u && d > 0 ? d : 0; });
      const tr = rma(trueRange(b), n), pdi = rma(pdm, n).map((x, i) => (100 * x) / tr[i]), mdi = rma(mdm, n).map((x, i) => (100 * x) / tr[i]);
      const adx = rma(pdi.map((x, i) => (x + mdi[i] ? (100 * Math.abs(x - mdi[i])) / (x + mdi[i]) : 0)), n);
      return [{ name: '+DI', color: '#f0524f', data: pdi }, { name: '-DI', color: '#22b07d', data: mdi }, { name: 'ADX', color: C[0], data: adx }]; } },
  { id: 'obv', name: 'OBV 能量潮', pane: 'sub', params: [{ label: '均線', def: 20 }],
    calc: (b, [n]) => { let s = 0; const o = b.map((x, i) => (s += i ? Math.sign(x.c - b[i - 1].c) * x.v : 0)); return [{ name: 'OBV', color: C[0], data: o }, { name: `MA${n}`, color: C[1], data: sma(o, n) }]; } },
  { id: 'cci', name: 'CCI 順勢指標', pane: 'sub', params: [{ label: '週期', def: 20 }], levels: [-100, 100],
    calc: (b, [n]) => { const tp = b.map((x) => (x.h + x.l + x.c) / 3), m = sma(tp, n);
      return [{ name: 'CCI', color: C[0], data: tp.map((x, i) => { if (!Number.isFinite(m[i])) return NaN; let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]); md /= n; return md ? (x - m[i]) / (0.015 * md) : 0; }) }]; } },
  { id: 'wr', name: '威廉指標 %R', pane: 'sub', params: [{ label: '週期', def: 14 }], levels: [-80, -20],
    calc: (b, [n]) => { const H = hh(b.map((x) => x.h), n), L = ll(b.map((x) => x.l), n); return [{ name: '%R', color: C[0], data: b.map((x, i) => (H[i] === L[i] ? -50 : (-100 * (H[i] - x.c)) / (H[i] - L[i]))) }]; } },
  { id: 'bias', name: 'BIAS 乖離率', pane: 'sub', params: [{ label: 'B1', def: 6 }, { label: 'B2', def: 12 }, { label: 'B3', def: 24 }],
    calc: (b, p) => p.filter((n) => n > 0).map((n, i) => { const m = sma(cl(b), n); return { name: `BIAS${n}`, color: C[i], data: cl(b).map((x, j) => ((x - m[j]) / m[j]) * 100) }; }) },
  { id: 'psy', name: 'PSY 心理線', pane: 'sub', params: [{ label: '週期', def: 12 }], levels: [25, 75],
    calc: (b, [n]) => [{ name: 'PSY', color: C[0], data: sumN(cl(b).map((x, i, a) => (i && x > a[i - 1] ? 1 : 0)), n).map((x) => (x / n) * 100) }] },
  { id: 'atr', name: 'ATR 真實波幅', pane: 'sub', params: [{ label: '週期', def: 14 }],
    calc: (b, [n]) => [{ name: 'ATR', color: C[0], data: rma(trueRange(b), n) }] },
  { id: 'mtm', name: 'MTM 動量', pane: 'sub', params: [{ label: '週期', def: 10 }, { label: '均線', def: 6 }],
    calc: (b, [n, m]) => { const v = cl(b).map((x, i, a) => (i >= n ? x - a[i - n] : NaN)); return [{ name: 'MTM', color: C[0], data: v }, { name: `MA${m}`, color: C[1], data: sma(v, m) }]; } },
  { id: 'roc', name: 'ROC 變動率', pane: 'sub', params: [{ label: '週期', def: 12 }, { label: '均線', def: 6 }],
    calc: (b, [n, m]) => { const v = cl(b).map((x, i, a) => (i >= n ? ((x - a[i - n]) / a[i - n]) * 100 : NaN)); return [{ name: 'ROC', color: C[0], data: v }, { name: `MA${m}`, color: C[1], data: sma(v, m) }]; } },
  { id: 'trix', name: 'TRIX 三重指數', pane: 'sub', params: [{ label: '週期', def: 12 }, { label: '訊號', def: 9 }],
    calc: (b, [n, m]) => { const t = ema(ema(ema(cl(b), n), n), n); const v = t.map((x, i) => (i && Number.isFinite(t[i - 1]) ? ((x - t[i - 1]) / t[i - 1]) * 100 : NaN)); return [{ name: 'TRIX', color: C[0], data: v }, { name: 'MATRIX', color: C[1], data: sma(v, m) }]; } },
  { id: 'dma', name: 'DMA 平均差', pane: 'sub', params: [{ label: '短', def: 10 }, { label: '長', def: 50 }, { label: '均線', def: 10 }],
    calc: (b, [s, l, m]) => { const d = sma(cl(b), s).map((x, i) => x - sma(cl(b), l)[i]); return [{ name: 'DMA', color: C[0], data: d }, { name: 'AMA', color: C[1], data: sma(d, m) }]; } },
  { id: 'mfi', name: 'MFI 資金流量', pane: 'sub', params: [{ label: '週期', def: 14 }], levels: [20, 80],
    calc: (b, [n]) => { const tp = b.map((x) => (x.h + x.l + x.c) / 3);
      const pos = sumN(tp.map((x, i) => (i && x > tp[i - 1] ? x * b[i].v : 0)), n), neg = sumN(tp.map((x, i) => (i && x < tp[i - 1] ? x * b[i].v : 0)), n);
      return [{ name: 'MFI', color: C[0], data: pos.map((p, i) => (p + neg[i] ? (100 * p) / (p + neg[i]) : 50)) }]; } },
  { id: 'arbr', name: 'AR/BR 人氣意願', pane: 'sub', params: [{ label: '週期', def: 26 }],
    calc: (b, [n]) => { const ho = sumN(b.map((x) => x.h - x.o), n), ol = sumN(b.map((x) => x.o - x.l), n);
      const hc = sumN(b.map((x, i) => (i ? Math.max(0, x.h - b[i - 1].c) : 0)), n), cl2 = sumN(b.map((x, i) => (i ? Math.max(0, b[i - 1].c - x.l) : 0)), n);
      return [{ name: 'AR', color: C[0], data: ho.map((x, i) => (100 * x) / ol[i]) }, { name: 'BR', color: C[1], data: hc.map((x, i) => (100 * x) / cl2[i]) }]; } },
  { id: 'vr', name: 'VR 成交量比率', pane: 'sub', params: [{ label: '週期', def: 26 }],
    calc: (b, [n]) => { const up = sumN(b.map((x, i) => (i && x.c > b[i - 1].c ? x.v : 0)), n), dn = sumN(b.map((x, i) => (i && x.c < b[i - 1].c ? x.v : 0)), n), eq = sumN(b.map((x, i) => (i && x.c === b[i - 1].c ? x.v : 0)), n);
      return [{ name: 'VR', color: C[0], data: up.map((u, i) => ((u + eq[i] / 2) / (dn[i] + eq[i] / 2 || 1)) * 100) }]; } },
  { id: 'cmo', name: 'CMO 錢德動量', pane: 'sub', params: [{ label: '週期', def: 14 }], levels: [-50, 50],
    calc: (b, [n]) => { const ch = cl(b).map((x, i, a) => (i ? x - a[i - 1] : 0)); const su = sumN(ch.map((x) => Math.max(x, 0)), n), sd = sumN(ch.map((x) => Math.max(-x, 0)), n);
      return [{ name: 'CMO', color: C[0], data: su.map((u, i) => (u + sd[i] ? (100 * (u - sd[i])) / (u + sd[i]) : 0)) }]; } },
];

export const findInd = (id: string) => INDICATORS.find((d) => d.id === id);
