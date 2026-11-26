// K 棒週期：1/3/5/15/30/自訂分鐘、日、週、月、還原日（K線與技術分析共用）
// shioaji kbars 只有 1 分 K（以結束時間標記）→ 自行彙整
import { hub } from './hub';
import { regroup, toDaily } from './indicators';
import { tpeToday } from './util';
import type { Bar, Contract } from '../types';

export type Interval = string; // 'm1' 'm3' 'm5' 'm15' 'm30' 'm<N>' 'day' 'week' 'month' 'adj'
export const INTERVALS: [Interval, string][] = [
  ['m1', '1分'], ['m3', '3分'], ['m5', '5分'], ['m15', '15分'], ['m30', '30分'], ['custom', '自訂'],
  ['day', '日K'], ['week', '週K'], ['month', '月K'], ['adj', '還原日K'],
];
export const isMinute = (iv: Interval) => /^m\d+$/.test(iv);
export const minutesOf = (iv: Interval) => Number(iv.slice(1));
export const labelOf = (iv: Interval) => (isMinute(iv) ? `${minutesOf(iv)}分` : INTERVALS.find((x) => x[0] === iv)?.[1] ?? iv);

/** 抓幾天的 1 分 K：週期越長抓越多天，分 K 約維持 250–600 根 */
function daysFor(iv: Interval) {
  if (iv === 'day' || iv === 'adj') return 200;
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

/** 除權息事件（由轉接站抓證交所／櫃買公開資料）；不支援時回空陣列並附原因 */
export interface ExRight { date: string; before: number; ref: number }
export async function exRights(code: string): Promise<{ list: ExRight[]; error?: string }> {
  try {
    const r = await fetch(`/mw/exright?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) {
      return { list: [], error: '還原日K需要從 http://localhost:5180（npm.cmd run phone）開啟，才能取得證交所／櫃買除權息資料' };
    }
    const d = await r.json() as { list?: ExRight[]; error?: string };
    return { list: d.list ?? [], error: d.error };
  } catch { return { list: [], error: '無法取得除權息資料' }; }
}

/** 還原（向前調整）：除權息日之前的價格 × (參考價 ÷ 除權息前收盤)，多次事件累乘 */
export function adjust(days: Bar[], ev: ExRight[]): Bar[] {
  const evs = ev.map((e) => ({ t: Date.parse(e.date + 'T00:00:00Z') / 1000, f: e.ref / e.before }))
    .filter((e) => e.f > 0 && e.f < 1.5).sort((a, b) => b.t - a.t);
  let f = 1, k = 0;
  const out: Bar[] = [];
  for (let i = days.length - 1; i >= 0; i--) {
    const b = days[i];
    while (k < evs.length && evs[k].t > b.t) { f *= evs[k].f; k++; }
    out.push(f === 1 ? b : { ...b, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f });
  }
  return out.reverse();
}

export async function buildBars(c: Contract, iv: Interval): Promise<{ bars: Bar[]; minute: Bar[]; note?: string }> {
  const minute = await minuteBars(c, daysFor(iv));
  if (isMinute(iv)) return { bars: aggregateMinutes(minute, minutesOf(iv)), minute };
  const days = toDaily(minute);
  if (iv === 'week' || iv === 'month') return { bars: regroup(days, iv), minute };
  if (iv === 'adj') {
    const { list, error } = await exRights(c.code);
    return { bars: adjust(days, list), minute, note: error ?? (list.length ? `已還原 ${list.length} 次除權息` : '期間內沒有除權息') };
  }
  return { bars: days, minute };
}
