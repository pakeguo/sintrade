// 技術指標與 K 棒彙整（純函式）
import type { Bar } from '../types';

/** 1 分 K → 日 K（以台北日期分組） */
export function toDaily(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const day = Math.floor(b.t / 86400) * 86400;
    const last = out[out.length - 1];
    if (last && last.t === day) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v;
    } else out.push({ t: day, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

/** 日 K → 週 K／月 K */
export function regroup(days: Bar[], unit: 'week' | 'month'): Bar[] {
  const key = (t: number) => {
    const d = new Date(t * 1000);
    if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    const wd = (d.getUTCDay() + 6) % 7; // 週一為一週開始
    return t - wd * 86400;
  };
  const out: Bar[] = [];
  for (const b of days) {
    const k = key(b.t);
    const last = out[out.length - 1];
    if (last && last.t === k) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v;
    } else out.push({ ...b, t: k });
  }
  return out;
}

export function sma(vals: number[], n: number): number[] {
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= n) s -= vals[i - n];
    out.push(i >= n - 1 ? s / n : NaN);
  }
  return out;
}

export function bollinger(vals: number[], n = 20, k = 2) {
  const mid = sma(vals, n);
  const up: number[] = [], dn: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < n - 1) { up.push(NaN); dn.push(NaN); continue; }
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (vals[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    up.push(mid[i] + k * sd); dn.push(mid[i] - k * sd);
  }
  return { mid, up, dn };
}

/** RSI（Wilder 平滑） */
export function rsi(vals: number[], n = 14): number[] {
  const out: number[] = [NaN];
  let g = 0, l = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; out.push(i === n ? 100 - 100 / (1 + g / (l || 1e-9)) : NaN); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out.push(100 - 100 / (1 + g / (l || 1e-9)));
  }
  return out;
}

/** 當日 VWAP（以每分 K 的典型價近似） */
export function vwap(bars: Bar[]): number[] {
  let pv = 0, v = 0;
  return bars.map((b) => { pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v; return v ? pv / v : b.c; });
}

/** 分價量表：把每分 K 的量分配到價格區間 */
export function volumeProfile(bars: Bar[], bins = 28) {
  if (!bars.length) return { rows: [] as { lo: number; hi: number; v: number }[], poc: NaN };
  const lo = Math.min(...bars.map((b) => b.l)), hi = Math.max(...bars.map((b) => b.h));
  const step = (hi - lo) / bins || 1;
  const rows = Array.from({ length: bins }, (_, i) => ({ lo: lo + i * step, hi: lo + (i + 1) * step, v: 0 }));
  for (const b of bars) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((b.h + b.l + b.c) / 3 - lo) / step)));
    rows[i].v += b.v;
  }
  const top = rows.reduce((a, r) => (r.v > a.v ? r : a), rows[0]);
  return { rows, poc: (top.lo + top.hi) / 2 };
}
