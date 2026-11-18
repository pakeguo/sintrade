// 臺指選擇權共用邏輯：到期日清單、T 字報價列、合成期貨、IV／Delta 與各項關鍵指標
// 期權頁（即時訂閱）與總覽（快照）共用同一套計算，確保兩邊數字一致。
import { delta as bsDelta, impliedVol, yearsToExpiry } from '../bs';
import { hub } from './hub';
import { avg, fin, isLive } from './util';
import type { OptContract } from '../types';

export interface Expiry {
  key: string; root: string; date: string; label: string; kind: string; list: OptContract[];
}
export interface Row { k: number; c?: OptContract; p?: OptContract }
export interface Metrics {
  F: number; T: number; atm?: Row; straddle: number; atmIV: number; skew: number;
  pcr: number; callVol: number; putVol: number; maxCall?: Row; maxPut?: Row;
  iv: Map<string, number>; dl: Map<string, number>; maxVol: number;
}

/** 列出未到期的臺指選擇權（月選 TXO + 週選），依到期日排序 */
export async function loadTxoExpiries(): Promise<Expiry[]> {
  const roots = await hub.be.optionRoots();
  // 臺指選擇權家族：月選 TXO + 各週選（名稱為「臺指選擇權…」或 TX1–TX5）
  const fam = roots.filter((r) => r.root === 'TXO' || /^TX[1-5]$/.test(r.root) || r.name.startsWith('臺指選擇權'));
  const lists = await Promise.all(fam.map((r) => hub.be.optionChain(r.root).catch((e) => {
    if (r.root === 'TXO') throw e; // 月選都拿不到，代表 server 還沒就緒 → 交給 retry
    return [] as OptContract[];
  })));
  const groups = new Map<string, Expiry>();
  for (const list of lists) {
    for (const o of list) {
      if (!isLive(o.delivery_date)) continue;
      const key = `${o.root}:${o.delivery_date}`;
      let g = groups.get(key);
      if (!g) {
        const wd = new Date(o.delivery_date + 'T00:00:00Z').getUTCDay();
        const kind = o.root === 'TXO' ? '月選' : wd === 3 ? '週三' : wd === 5 ? '週五' : '週選';
        const [, m, d] = o.delivery_date.split('-');
        g = { key, root: o.root, date: o.delivery_date, kind, label: `${+m}/${+d}`, list: [] };
        groups.set(key, g);
      }
      g.list.push(o);
    }
  }
  return [...groups.values()].filter((g) => g.list.length >= 10)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.root === 'TXO' ? 1 : -1)).slice(0, 8);
}

const rowsCache = new WeakMap<Expiry, Row[]>();
export function rowsOf(e: Expiry): Row[] {
  let rs = rowsCache.get(e);
  if (rs) return rs;
  const m = new Map<number, Row>();
  for (const o of e.list) {
    const r = m.get(o.strike) ?? { k: o.strike };
    if (o.right === 'C') r.c = o; else r.p = o;
    m.set(o.strike, r);
  }
  rs = [...m.values()].sort((a, b) => a.k - b.k);
  rowsCache.set(e, rs);
  return rs;
}

/** 可用於計算的「公平價」：五檔中價優先（價差合理時），否則最近成交價 */
export function fair(code: string): number {
  const x = hub.quotes.get(code);
  if (!x) return NaN;
  const live = x.bids.length > 0 || x.asks.length > 0;
  const b = live ? x.bids[0]?.[0] : x.snapBid, a = live ? x.asks[0]?.[0] : x.snapAsk;
  if (b > 0 && a > 0 && a >= b) {
    const mid = (a + b) / 2;
    if (a - b <= Math.max(mid * 0.25, 2)) return mid;
  }
  return x.last;
}

/** 合成期貨 F = K + C − P（取最接近價平的 3 檔平均），這是該到期的真正標的價格 */
export function synthetic(rows: Row[]): number {
  const futLast = hub.quotes.get(hub.futKey)?.last ?? NaN;
  const base = fin(futLast) ? futLast : hub.idx?.close ?? NaN;
  if (!fin(base)) return NaN;
  const rs = rows.filter((r) => r.c && r.p)
    .sort((a, b) => Math.abs(a.k - base) - Math.abs(b.k - base)).slice(0, 3);
  const vals = rs.map((r) => r.k + fair(r.c!.code) - fair(r.p!.code)).filter(fin);
  if (!vals.length) return base;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export function computeMetrics(e: Expiry | null): Metrics {
  const all = e ? rowsOf(e) : [];
  const F = synthetic(all);
  const T = e ? yearsToExpiry(e.date) : NaN;
  const iv = new Map<string, number>(), dl = new Map<string, number>();
  let callVol = 0, putVol = 0, maxVol = 0;
  let maxCall: Row | undefined, maxPut: Row | undefined;
  for (const r of all) {
    for (const o of [r.c, r.p]) {
      if (!o) continue;
      const v = hub.quotes.get(o.code)?.vol ?? 0;
      if (o.right === 'C') { callVol += v; if (!maxCall || v > (hub.quotes.get(maxCall.c!.code)?.vol ?? 0)) maxCall = r; }
      else { putVol += v; if (!maxPut || v > (hub.quotes.get(maxPut.p!.code)?.vol ?? 0)) maxPut = r; }
      if (v > maxVol) maxVol = v;
      const s = impliedVol(fair(o.code), F, o.strike, T, o.right);
      iv.set(o.code, s);
      if (fin(s)) dl.set(o.code, bsDelta(F, o.strike, T, s, o.right));
    }
  }
  const atm = all.filter((r) => r.c && r.p).sort((a, b) => Math.abs(a.k - F) - Math.abs(b.k - F))[0];
  const straddle = atm ? fair(atm.c!.code) + fair(atm.p!.code) : NaN;
  const atmIV = atm ? avg([iv.get(atm.c!.code)!, iv.get(atm.p!.code)!]) : NaN;
  // 25 Delta 偏斜：Put(Δ≈−0.25) IV − Call(Δ≈+0.25) IV
  const near = (right: 'C' | 'P', target: number) => {
    let best: string | undefined, bd = 1;
    for (const [code, d] of dl) {
      if ((right === 'C') !== d > 0) continue;
      if (Math.abs(d - target) < bd) { bd = Math.abs(d - target); best = code; }
    }
    return best && bd < 0.12 ? iv.get(best)! : NaN;
  };
  const skew = (near('P', -0.25) - near('C', 0.25)) * 100;
  return {
    F, T, atm, straddle, atmIV, skew, pcr: callVol ? putVol / callVol : NaN,
    callVol, putVol, maxCall, maxPut, iv, dl, maxVol,
  };
}

/** 文字標籤（期權頁與總覽共用） */
export const skewLabel = (s: number) => (!fin(s) ? '' : s > 3 ? '避險需求強' : s < 0 ? 'Call 追價' : '正常');
export const pcrLabel = (p: number) => (!fin(p) ? '' : p > 1.2 ? 'Put 量明顯多' : p < 0.8 ? 'Call 量明顯多' : '均衡');
