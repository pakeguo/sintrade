// 證券手續費與電子折讓（唯讀估算）
//
// 依使用者 2026/08 永豐月對帳單反推、逐筆核對一致的規則（docs/ai/decisions.md）：
//   - 每筆手續費 = floor(成交金額 × 0.1425%)（成交時以原價收取）
//   - 「大戶投電子首百萬 2 折」：當月累計成交金額的前 100 萬，折讓 = floor(min(月成交, 100萬) × 0.1425% × (1 − 0.2))
//   - 「電子單預設」2.2 折：100 萬以後的每一筆，折讓 = floor(該筆手續費 × 超過部分比例 × (1 − 0.22))
//     （跨過 100 萬的那一筆依金額比例拆開）
// 8 月對帳單：成交 9,610,920、手續費 13,675 → 折讓 1,140 ＋ 9,538，本模組算出相同數字。
//
// 成交資料來源（shioaji 沒有「當月成交明細」的帳務查詢，用三種唯讀查詢拼出來）：
//   賣出＝profit_loss（期間內每筆賣出）；買進＝profit_loss_detail（已賣掉的買進明細）＋ position_detail（還在庫存的買進）
import { hub } from './hub';
import { account } from './account';
import { tpeToday } from './util';
import type { Account } from '../types';

export const FEE = { rate: 0.001425, tier: 1_000_000, d1: 0.2, d2: 0.22 };

export interface Trade { date: string; code: string; side: 'B' | 'S'; qty: number; price: number; amount: number; fee: number }
export interface FeeResult {
  month: string; trades: Trade[]; amount: number; fee: number;
  base1: number; rebate1: number; base2: number; rebate2: number; rebate: number; net: number; note?: string;
}

/** 依對帳單規則計算折讓（trades 需依時間排序） */
export function computeRebate(month: string, trades: Trade[]): FeeResult {
  let cum = 0, rebate2 = 0;
  for (const t of trades) {
    const p1 = Math.max(0, Math.min(t.amount, FEE.tier - cum));
    cum += t.amount;
    const p2 = t.amount - p1;
    if (p2 > 0 && t.amount > 0) rebate2 += Math.floor(t.fee * (p2 / t.amount) * (1 - FEE.d2));
  }
  const amount = cum;
  const fee = trades.reduce((s, t) => s + t.fee, 0);
  const base1 = Math.min(amount, FEE.tier);
  const rebate1 = Math.floor(base1 * FEE.rate * (1 - FEE.d1));
  return { month, trades, amount, fee, base1, rebate1, base2: amount - base1, rebate2, rebate: rebate1 + rebate2, net: fee - rebate1 - rebate2 };
}

const num = (x: unknown) => Number(String(x ?? '').replace(/,/g, '')) || 0;
const day = (x: unknown) => String(x ?? '').slice(0, 10).replace(/\//g, '-');
const feeOf = (amount: number) => Math.floor(amount * FEE.rate);
const body = (a: Account, extra: Record<string, unknown> = {}) =>
  ({ account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id, ...extra });

const cache = new Map<string, { at: number; r: FeeResult }>();

/** 查某月（YYYY-MM）的證券成交並計算手續費折讓；本月 5 分鐘快取、過去月份長期快取 */
export async function monthFees(month: string): Promise<FeeResult> {
  const isCur = month === tpeToday().slice(0, 7);
  const hit = cache.get(month);
  if (hit && (!isCur || Date.now() - hit.at < 5 * 60_000)) return hit.r;
  const a = account.state.sAccount;
  if (!a) throw new Error('沒有證券帳戶（API Key 需綁定證券帳戶）');
  const begin = `${month}-01`;
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
  const end = isCur ? tpeToday() : last;
  const inMonth = (d: string) => d >= begin && d <= last;

  const [sells, open] = await Promise.all([
    hub.be.portfolio<Record<string, unknown>[]>('profit_loss', body(a, { begin_date: begin, end_date: end, unit: 'Share' })),
    hub.be.portfolio<Record<string, unknown>[]>('position_detail', body(a, { unit: 'Share' })).catch(() => [] as Record<string, unknown>[]),
  ]);
  const trades: Trade[] = [];
  let unit = 1; // 回傳的數量若是「張」，以買進明細的成本反推換算倍數
  const legs = await Promise.all((sells ?? []).map((s) =>
    hub.be.portfolio<Record<string, unknown>[]>('profit_loss_detail', body(a, { detail_id: s.id, unit: 'Share' })).catch(() => [] as Record<string, unknown>[])));
  for (const l of legs.flat()) {
    const px = num(l.price), q = num(l.quantity), cost = num(l.cost);
    if (px > 0 && q > 0 && cost > px * q * 100) { unit = 1000; break; }
  }
  for (const s of sells ?? []) {
    const d = day(s.date);
    if (!inMonth(d)) continue;
    const qty = num(s.quantity) * unit, price = num(s.price), amount = Math.round(price * qty);
    trades.push({ date: d, code: String(s.code ?? ''), side: 'S', qty, price, amount, fee: feeOf(amount) });
  }
  for (const l of legs.flat()) {
    const d = day(l.date);
    if (!inMonth(d)) continue;
    const qty = num(l.quantity) * unit, price = num(l.price), amount = Math.round(price * qty);
    trades.push({ date: d, code: String(l.code ?? ''), side: 'B', qty, price, amount, fee: num(l.fee) || feeOf(amount) });
  }
  for (const p of open ?? []) {
    const d = day(p.date);
    if (!inMonth(d) || String(p.direction ?? 'Buy') !== 'Buy') continue;
    const qty = num(p.quantity) * unit, price = num(p.price), amount = Math.round(price * qty);
    trades.push({ date: d, code: String(p.code ?? ''), side: 'B', qty, price, amount, fee: num(p.fee) || feeOf(amount) });
  }
  trades.sort((x, y) => x.date.localeCompare(y.date));
  const r = computeRebate(month, trades);
  cache.set(month, { at: Date.now(), r });
  return r;
}
