// K 棒週期：1/3/5/15/30/自訂分鐘、日、週、月（K線與技術分析共用）
// shioaji kbars 只有 1 分 K（以結束時間標記）→ 自行彙整
import { hub } from './hub';
import { regroup, toDaily } from './indicators';
import { dayStart, derivBucket, isDeriv, sessionDay } from './session';
import { idbGet, idbSet } from './idb';
import { isLive, tpeToday } from './util';
import type { Bar, Contract } from '../types';

export type Interval = string; // 'm1' 'm3' 'm5' 'm15' 'm30' 'm<N>' 'day' 'week' 'month'
export const INTERVALS: [Interval, string][] = [
  ['m1', '1分'], ['m3', '3分'], ['m5', '5分'], ['m15', '15分'], ['m30', '30分'],
  ['day', '日K'], ['week', '週K'], ['month', '月K'],
];
export const isMinute = (iv: Interval) => /^m\d+$/.test(iv);
export const minutesOf = (iv: Interval) => Number(iv.slice(1));
export const labelOf = (iv: Interval) => (isMinute(iv) ? `${minutesOf(iv)}分` : INTERVALS.find((x) => x[0] === iv)?.[1] ?? iv);

// ───────── 歷史資料：目標 1000 根，先顯示最近、再往前分批補；讀過的存 IndexedDB ─────────
//   分K：快取 1 分 K（最多保留約 400 天）；日／週／月K：快取彙整後的日K（1 分 K 量太大不保存）
//   期貨近月的日K用連續月（TXFR1）才有多年歷史；遠月與選擇權只用自己的合約
export const TARGET = 1000;
const FLOOR = '2018-12-01';          // shioaji 1 分 K 最早約從這時候開始
const MINUTE_KEEP = 400;             // 分K快取最多保留幾個日曆天

interface Hist { bars: Bar[]; from: string; to: string; done?: boolean } // from：已抓到最早日期；to：下次從這天重抓；done：更早已無資料
const mem = new Map<string, Hist>();
const locks = new Map<string, Promise<unknown>>();
function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // 前一個讀取若卡住（server 沒回應），最多等 20 秒就不再等它，避免畫面永遠空白（pitfalls #24）
  const prev = Promise.race([(locks.get(key) ?? Promise.resolve()).catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))]);
  const next = prev.then(fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}
const addDays = (date: string, n: number) => new Date(dayStart(date) * 1000 + n * 86400_000).toISOString().slice(0, 10);

/** 期貨近月 → 連續月合約（日K歷史用）；其他商品用自己 */
const nearCache = new Map<string, string>();
async function historySource(c: Contract): Promise<Contract> {
  if (c.security_type !== 'FUT' || /R\d$/.test(c.code)) return c;
  const root = c.code.slice(0, 3);
  let near = nearCache.get(root);
  if (!near) {
    const list = await hub.be.futuresList(root).catch(() => []);
    near = list.filter((f) => isLive(f.delivery_date)).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date))[0]?.code ?? '';
    nearCache.set(root, near);
  }
  return near === c.code ? { security_type: 'FUT', exchange: c.exchange || 'TAIFEX', code: root + 'R1' } : c;
}

type Progress = (r: { bars: Bar[]; minute: Bar[]; loading: boolean; note?: string; error?: string }) => void;
let lastError = '';

/**
 * 抓歷史：先從快取最後一天補到今天，再往前分批抓到「夠了」（enough）或沒有更早的資料。
 * kind 'm'＝存 1 分 K、'd'＝存日K（每批 1 分 K 立即彙整成日K）
 */
async function history(kind: 'm' | 'd', src: Contract, deriv: boolean, enough: (bars: Bar[]) => boolean,
  alive: () => boolean, emit: (bars: Bar[]) => void): Promise<Bar[]> {
  const key = `${kind}:${src.code}`;
  return lock(key, async () => {
    const today = tpeToday();
    const chunk = kind === 'm' ? (deriv ? 10 : 30) : (deriv ? 21 : 90);
    const toUnit = (mins: Bar[]) => (kind === 'm' ? mins : toDaily(mins, deriv ? (t) => dayStart(sessionDay(t)) : undefined));
    const fetch = (a: string, b: string) => hub.be.kbars(src, a, b).then(toUnit, (e) => { lastError = String((e as Error)?.message ?? e); throw e; });
    let h = mem.get(key) ?? (await idbGet<Hist>(key)) ?? { bars: [], from: today, to: '' };
    // 1) 往後補：從快取的前一個交易日重抓（期貨夜盤屬於下一交易日，所以多抓一天），只換掉 to 之後的 K 棒
    if (h.to) {
      const fresh = await fetch(addDays(h.to, -3), today).catch(() => null);
      if (fresh) {
        const cut = dayStart(h.to);
        h = { ...h, bars: [...h.bars.filter((b) => b.t < cut), ...fresh.filter((b) => b.t >= cut)] };
      }
    } else {
      const from = addDays(today, -chunk);
      const fresh = await fetch(from, today).catch(() => [] as Bar[]);
      h = { bars: fresh, from, to: '' };
    }
    h.to = addDays(today, -1);
    mem.set(key, h);
    emit(h.bars);
    // 2) 往前補，直到夠用、沒有更早的資料、或超過保留期限
    const limit = kind === 'm' ? addDays(today, -MINUTE_KEEP) : FLOOR;
    let empties = 0;
    while (alive() && !h.done && !enough(h.bars) && h.from > limit) {
      await new Promise((r) => setTimeout(r, 0));             // 讓出主執行緒，補資料時畫面不卡
      const to = addDays(h.from, -1), from = addDays(h.from, -chunk);
      const part = await fetch(from, to).catch(() => null);
      if (!part) break;                                        // 連線錯誤：先停，下次再補
      empties = part.length ? 0 : empties + 1;
      const first = h.bars[0];
      const last = part[part.length - 1];
      if (first && last && last.t === first.t) {               // 日K跨批次的同一個交易日（期貨夜盤）合併
        first.o = last.o; first.h = Math.max(first.h, last.h); first.l = Math.min(first.l, last.l); first.v += last.v;
        part.pop();
      }
      h = { ...h, bars: [...part, ...h.bars], from };
      if (empties >= 3) h.done = true;                         // 連續三批沒資料＝更早沒有了（新上市、新合約）
      mem.set(key, h);
      emit(h.bars);
    }
    if (kind === 'm') {                                        // 分K快取只留最近 MINUTE_KEEP 天
      const cut = dayStart(limit);
      if (h.bars.length && h.bars[0].t < cut) h = { ...h, bars: h.bars.filter((b) => b.t >= cut), from: limit, done: false };
    }
    mem.set(key, h);
    idbSet(key, h);
    return h.bars;
  });
}

/** 現股 N 分 K：以 09:00 為起點每 N 分鐘一根，以結束時間標記（最後一根最晚 13:30） */
function stockBucket(t1: number, n: number) {
  const day = Math.floor(t1 / 86400) * 86400;
  const m = Math.round((t1 - day) / 60);
  const end = Math.min(13 * 60 + 30, 9 * 60 + Math.ceil((m - 9 * 60) / n) * n);
  return day + Math.max(end, 9 * 60 + n) * 60;
}

/** N 分 K：現股以 09:00 為起點；期貨／選擇權日盤以 08:45、夜盤以 15:00 為起點（core/session.ts） */
export function aggregateMinutes(bars: Bar[], n: number, deriv = false): Bar[] {
  if (n <= 1) return bars.map((b) => ({ ...b }));
  const out: Bar[] = [];
  for (const b of bars) {
    const t = deriv ? derivBucket(b.t, n) ?? b.t : stockBucket(b.t, n);
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

/**
 * 依週期組出 K 棒。onProgress 每補到一批資料就回報（先最近、再往前），loading=false 為最後一次。
 * alive() 回傳 false 時（切換商品或週期）停止往前補。
 */
export async function buildBars(c: Contract, iv: Interval, onProgress?: Progress, alive: () => boolean = () => true) {
  const deriv = isDeriv(c);
  lastError = '';
  let result: { bars: Bar[]; minute: Bar[]; note?: string } = { bars: [], minute: [] };
  if (isMinute(iv)) {
    const n = minutesOf(iv);
    const agg = (m: Bar[]) => aggregateMinutes(m, n, deriv);
    const minute = await history('m', c, deriv, (m) => agg(m).length >= TARGET, alive,
      (m) => onProgress?.({ bars: agg(m), minute: m, loading: true }));
    const bars = agg(minute);
    result = { bars, minute, note: bars.length < TARGET * 0.9 ? `${labelOf(iv)}最多保留約 ${MINUTE_KEEP} 天：共 ${bars.length} 根` : undefined };
  } else {
    const src = await historySource(c);
    const shape = (d: Bar[]) => (iv === 'week' || iv === 'month' ? regroup(d, iv) : d);
    // 週／月K：個股盡量抓滿（約 2018 年起）；期貨、選擇權維持 1000 根日K（資料量太大）
    const want = iv === 'day' || deriv ? TARGET : Infinity;
    const run = (from: Contract) => history('d', from, deriv, (d) => d.length >= want, alive,
      (d) => onProgress?.({ bars: shape(d), minute: d, loading: true }));
    let days = await run(src);
    if (!days.length && src !== c) days = await run(c); // 連續月抓不到 → 改用合約本身
    result = { bars: shape(days), minute: days };
  }
  if (!result.bars.length && lastError) result.note = `讀取失敗：${lastError}`;
  onProgress?.({ ...result, loading: false, error: !result.bars.length ? lastError || '沒有資料' : undefined });
  return result;
}

/** 即時成交 → 更新（或新增）最後一根 K 棒；回傳是否有變動。規則與 aggregateMinutes／toDaily／regroup 一致 */
export function applyTick(bars: Bar[], iv: Interval, t: number, price: number, vol: number, deriv = false): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const t1 = Math.ceil(t / 60) * 60;                          // 1 分 K 以結束時間標記
  let day = Math.floor(t / 86400) * 86400;
  if (deriv) {
    if (derivBucket(t1, 1) == null) return false;              // 期貨／選擇權休市時段
    day = dayStart(sessionDay(t1));
  } else {
    const m1 = (t1 - day) / 60;
    if (m1 < 9 * 60 || m1 > 13 * 60 + 30 + 1) return false;    // 只處理現股交易時段
  }
  let key: number;
  if (isMinute(iv)) {
    const n = minutesOf(iv);
    key = deriv ? derivBucket(t1, n)! : stockBucket(t1, n);
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
