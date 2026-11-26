// 交易時段共用工具（台北時間當 UTC 的秒數，與 Bar.t 相同）
//   現股：09:00–13:30
//   期貨／選擇權：日盤 08:45–13:45、夜盤 15:00–隔日 05:00
//   期貨「交易日」＝台灣券商全盤日K：前一交易日 15:00 夜盤開盤 → 當日 13:45 日盤收盤
import type { Contract } from '../types';

export const dstr = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
export const minOf = (t: number) => { const d = new Date(t * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const dayStart = (date: string) => Date.parse(date + 'T00:00:00Z') / 1000;
export const isDeriv = (c: Contract | null | undefined) => c?.security_type === 'FUT' || c?.security_type === 'OPT';

export function shiftWeekday(date: string, dir: 1 | -1) {
  let x = dayStart(date);
  do { x += dir * 86400; } while ([0, 6].includes(new Date(x * 1000).getUTCDay()));
  return dstr(x);
}

/** K 棒屬於哪個交易日：15:00 後的夜盤算下一個平日；週六凌晨（週五夜盤延續）算下週一 */
export function sessionDay(t: number) {
  const d = dstr(t), m = minOf(t);
  if (m >= 15 * 60) return shiftWeekday(d, 1);
  if (m <= 5 * 60 && new Date(t * 1000).getUTCDay() === 6) return shiftWeekday(d, 1);
  return d;
}

/** 1 分 K（結束時間標記）是否屬於期貨日盤 08:46–13:45 */
export const isDayBar = (t: number) => { const m = minOf(t); return m >= 8 * 60 + 46 && m <= 13 * 60 + 45; };

/**
 * 期貨／選擇權的 N 分 K：日盤以 08:45、夜盤以 15:00 為起點每 N 分鐘一根，以結束時間標記，
 * 最後一根不超過收盤（13:45／05:00）。t1＝1 分 K 的結束時間；不在交易時段回傳 null
 */
export function derivBucket(t1: number, n: number): number | null {
  const day = Math.floor(t1 / 86400) * 86400;
  const m = Math.round((t1 - day) / 60);
  if (m >= 8 * 60 + 46 && m <= 13 * 60 + 45) {
    const a = 8 * 60 + 45;
    return day + Math.min(13 * 60 + 45, a + Math.ceil((m - a) / n) * n) * 60;
  }
  let base: number, rel: number;
  if (m >= 15 * 60 + 1) { base = day; rel = m - 15 * 60; }
  else if (m <= 5 * 60) { base = day - 86400; rel = m + 24 * 60 - 15 * 60; }
  else return null;
  return base + (15 * 60 + Math.min(14 * 60, Math.ceil(rel / n) * n)) * 60;
}
