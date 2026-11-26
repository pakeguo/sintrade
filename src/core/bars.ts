// K 棒週期：1/3/5/15/30/自訂分鐘、日、週、月（K線與技術分析共用）
// shioaji kbars 只有 1 分 K（以結束時間標記）→ 自行彙整
import { hub } from './hub';
import { regroup, toDaily } from './indicators';
import { tpeToday } from './util';
import type { Bar, Contract } from '../types';

export type Interval = string; // 'm1' 'm3' 'm5' 'm15' 'm30' 'm<N>' 'day' 'week' 'month'
export const INTERVALS: [Interval, string][] = [
  ['m1', '1分'], ['m3', '3分'], ['m5', '5分'], ['m15', '15分'], ['m30', '30分'],
  ['day', '日K'], ['week', '週K'], ['month', '月K'],
];
export const isMinute = (iv: Interval) => /^m\d+$/.test(iv);
export const minutesOf = (iv: Interval) => Number(iv.slice(1));
export const labelOf = (iv: Interval) => (isMinute(iv) ? `${minutesOf(iv)}分` : INTERVALS.find((x) => x[0] === iv)?.[1] ?? iv);

/** 抓幾天的 1 分 K：週期越長抓越多天，分 K 約維持 250–600 根 */
function daysFor(iv: Interval) {
  if (iv === 'day') return 200;
  if (iv === 'week' || iv === 'month') return 400;
  const n = minutesOf(iv);
  return Math.min(200, Math.max(3, Math.ceil(n * 2.2)));
}

const cache = new Map<string, { at: number; bars: Bar[]; days: number }>();
export async function minuteBars(c: Contract, days: number): Promise<Bar[]> {
  const hit = cache.get(c.code);
  if (hit && hit.days >= days && Date.now() - hit.at < 5 * 60_000) return hit.bars;
  const bars = await hub.be.kbars(c, tpeToday(-days), tpeToday()).catch(() => [] as Bar[]);
  cache.set(c.code, { at: Date.now(), bars, days });
  return bars;
}

/** N 分 K：以 09:00 為起點每 N 分鐘一根，以結束時間標記（最後一根最晚 13:30） */
export function aggregateMinutes(bars: Bar[], n: number): Bar[] {
  if (n <= 1) return bars.map((b) => ({ ...b }));
  const out: Bar[] = [];
  for (const b of bars) {
    const day = Math.floor(b.t / 86400) * 86400;
    const m = Math.round((b.t - day) / 60);
    const end = Math.min(13 * 60 + 30, 9 * 60 + Math.ceil((m - 9 * 60) / n) * n);
    const t = day + Math.max(end, 9 * 60 + n) * 60;
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

export async function buildBars(c: Contract, iv: Interval): Promise<{ bars: Bar[]; minute: Bar[]; note?: string }> {
  const minute = await minuteBars(c, daysFor(iv));
  if (isMinute(iv)) return { bars: aggregateMinutes(minute, minutesOf(iv)), minute };
  const days = toDaily(minute);
  if (iv === 'week' || iv === 'month') return { bars: regroup(days, iv), minute };
  return { bars: days, minute };
}

/** 即時成交 → 更新（或新增）最後一根 K 棒；回傳是否有變動。規則與 aggregateMinutes／toDaily／regroup 一致 */
export function applyTick(bars: Bar[], iv: Interval, t: number, price: number, vol: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const day = Math.floor(t / 86400) * 86400;
  const m1 = Math.ceil((t - day) / 60);                       // 1 分 K 以結束時間標記
  if (m1 < 9 * 60 || m1 > 13 * 60 + 30 + 1) return false;      // 只處理現股交易時段
  let key: number;
  if (isMinute(iv)) {
    const n = minutesOf(iv);
    const end = Math.min(13 * 60 + 30, 9 * 60 + Math.ceil((m1 - 9 * 60) / n) * n);
    key = day + Math.max(end, 9 * 60 + n) * 60;
  } else if (iv === 'week') {
    key = day - ((new Date(day * 1000).getUTCDay() + 6) % 7) * 86400;
  } else if (iv === 'month') {
    const d = new Date(day * 1000); key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  } else key = day;                                            // 日K
  const last = bars[bars.length - 1];
  if (last && last.t === key) {
    last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.v += vol;
    return true;
  }
  if (last && key < last.t) return false;
  bars.push({ t: key, o: price, h: price, l: price, c: price, v: vol });
  return true;
}
