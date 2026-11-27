// 模擬委託（下單頁）：只在瀏覽器裡記錄委託與「模擬成交」，**不會送出任何委託**（見 core/guard.ts）
//
// 撮合規則（近似交易所）：
//   - 下單當下：買價 ≥ 最佳賣價（或成交價）→ 立即以最佳賣價成交；賣價 ≤ 最佳買價 → 以最佳買價成交
//   - 掛單（ROD）：之後有成交價觸及委託價（買：成交價 ≤ 買價；賣：成交價 ≥ 賣價）→ 以委託價成交，數量以該筆成交量為上限
//   - IOC：下單當下不能成交就取消
// 部位＝實際庫存（帳務）＋今天的模擬成交；損益含手續費（2.2 折後）與證交稅（當沖 0.15%、一般 0.3%）
import { FEE } from './fees';
import { LS, tpeToday } from './util';

export type Cond = 'cash' | 'dt' | 'odd' | 'auto' | 'open' | 'close';  // 個股：現股、現股當沖、零股；期權：自動、新倉、平倉
export type Side = 'B' | 'S';
export type Tif = 'ROD' | 'IOC';
export const COND_NAME: Record<Cond, string> = { cash: '現股', dt: '現股當沖', odd: '零股', auto: '自動', open: '新倉', close: '平倉' };
export const isFopCond = (c: Cond) => c === 'auto' || c === 'open' || c === 'close';

export interface SimFill { at: number; price: number; qty: number }
export interface SimOrder {
  id: number; code: string; side: Side; price: number; qty: number; filled: number; cond: Cond; tif: Tif;
  status: 'working' | 'filled' | 'cancelled' | 'rejected'; at: number; fills: SimFill[]; note?: string;
  mkt?: boolean; // 市價單（以漲跌停價為限價、IOC，立即以對手價成交）
}

/** 費用：手續費以折後費率（2.2 折）估算，證交稅賣出時收 */
export const FEE_RATE = FEE.rate * FEE.d2;
export const taxRate = (cond: Cond) => (cond === 'dt' ? 0.0015 : 0.003);

// ───────── 升降單位（台股） ─────────
export function tickOf(p: number, etf: boolean): number {
  if (etf) return p < 50 ? 0.01 : 0.05;
  return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
}
const fix = (x: number) => Math.round(x * 100) / 100;
export const stepUp = (p: number, etf: boolean) => fix(p + tickOf(p, etf));
export const stepDown = (p: number, etf: boolean) => fix(p - tickOf(fix(p - 0.0001), etf));
export function snap(p: number, etf: boolean) { const t = tickOf(p, etf); return fix(Math.round(p / t) * t); }

/** 當沖損益兩平價：多單＝成本含買進手續費，賣出要再付手續費與當沖稅；空單相反 */
export function breakEven(avg: number, long: boolean) {
  return long ? (avg * (1 + FEE_RATE)) / (1 - FEE_RATE - 0.0015) : (avg * (1 - FEE_RATE - 0.0015)) / (1 + FEE_RATE);
}
/** 以 price 平倉 qty 股（正＝多單賣出、負＝空單買回）的淨損益 */
export function closePnl(avg: number, qty: number, price: number, cond: Cond) {
  const q = Math.abs(qty);
  if (qty > 0) return (price - avg) * q - (avg * q + price * q) * FEE_RATE - price * q * taxRate(cond);
  return (avg - price) * q - (avg * q + price * q) * FEE_RATE - avg * q * taxRate(cond);
}

// ───────── 委託簿 ─────────
interface Saved { date: string; seq: number; orders: SimOrder[] }

class SimBook {
  private d: Saved;
  private listeners = new Set<() => void>();
  constructor() {
    const s = LS.getJSON<Saved | null>('simOrders', null);
    this.d = s && s.date === tpeToday() ? s : { date: tpeToday(), seq: 1, orders: [] };
  }
  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private save() { LS.setJSON('simOrders', this.d); this.listeners.forEach((f) => f()); }
  private today() { if (this.d.date !== tpeToday()) this.d = { date: tpeToday(), seq: 1, orders: [] }; }

  orders(code?: string) { this.today(); return code ? this.d.orders.filter((o) => o.code === code) : this.d.orders; }
  working(code: string) { return this.orders(code).filter((o) => o.status === 'working'); }

  /** 新增委託；bestBid／bestAsk／last 用來判斷能否立即成交 */
  place(o: Omit<SimOrder, 'id' | 'filled' | 'status' | 'at' | 'fills'>, book: { bid: number; ask: number; last: number }, reject?: string): SimOrder {
    this.today();
    const order: SimOrder = { ...o, id: this.d.seq++, filled: 0, status: 'working', at: Date.now(), fills: [] };
    if (reject) { order.status = 'rejected'; order.note = reject; }
    else {
      const ask = book.ask > 0 ? book.ask : book.last, bid = book.bid > 0 ? book.bid : book.last;
      if (o.side === 'B' && ask > 0 && o.price >= ask) this.fill(order, ask, order.qty);
      else if (o.side === 'S' && bid > 0 && o.price <= bid) this.fill(order, bid, order.qty);
      else if (o.tif === 'IOC') { order.status = 'cancelled'; order.note = 'IOC 無法立即成交'; }
    }
    this.d.orders.push(order);
    this.save();
    return order;
  }
  cancel(id: number) {
    const o = this.d.orders.find((x) => x.id === id);
    if (o && o.status === 'working') { o.status = 'cancelled'; o.note = o.filled ? '剩餘取消' : undefined; this.save(); }
  }
  cancelAll(code: string) {
    let n = 0;
    for (const o of this.working(code)) { o.status = 'cancelled'; n++; }
    if (n) this.save();
  }
  clear() { this.d = { date: tpeToday(), seq: 1, orders: [] }; this.save(); }

  private fill(o: SimOrder, price: number, qty: number) {
    const q = Math.min(qty, o.qty - o.filled);
    if (q <= 0) return;
    o.fills.push({ at: Date.now(), price, qty: q });
    o.filled += q;
    if (o.filled >= o.qty) o.status = 'filled';
  }
  /** 即時成交：掛單價被觸及就成交（個股 vol 為張、委託以股計；期權 unit=1，都是口） */
  onTick(code: string, price: number, volLots: number, unit = 1000) {
    let changed = false;
    for (const o of this.working(code)) {
      const hit = o.side === 'B' ? price <= o.price : price >= o.price;
      if (!hit) continue;
      this.fill(o, o.price, Math.max(1, Math.round(volLots * unit)));   // 個股：張→股；期權：口
      changed = true;
    }
    if (changed) this.save();
  }

  /** 今天的模擬成交，依時間排序（部位計算用） */
  fills(code: string) {
    return this.orders(code).flatMap((o) => o.fills.map((f) => ({ ...f, side: o.side, cond: o.cond })))
      .sort((a, b) => a.at - b.at);
  }
}

export const simBook = new SimBook();

/** 部位＝實際庫存（qty 股、avg 成本）＋模擬成交；回傳淨股數、均價、今日模擬已實現損益 */
export function position(real: { qty: number; avg: number }, code: string) {
  let qty = real.qty, avg = real.avg, realized = 0, traded = 0;
  for (const f of simBook.fills(code)) {
    const q = f.side === 'B' ? f.qty : -f.qty;
    traded += f.qty;
    if (qty === 0 || Math.sign(qty) === Math.sign(q)) {           // 加碼：重算均價
      avg = (avg * Math.abs(qty) + f.price * f.qty) / (Math.abs(qty) + f.qty);
      qty += q;
    } else {                                                        // 減碼／平倉（可能反手）
      const close = Math.min(Math.abs(qty), f.qty);
      realized += closePnl(avg, Math.sign(qty) * close, f.price, f.cond);
      qty += q;
      if (Math.abs(q) > close) avg = f.price;                       // 反手：剩下的以成交價為新均價
      if (qty === 0) avg = 0;
    }
  }
  return { qty, avg, realized, traded };
}
