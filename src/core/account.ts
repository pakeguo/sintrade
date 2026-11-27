// 帳務服務（唯讀）：期權保證金、未平倉部位、證券庫存、今日已實現損益
//
// - 每 15 秒向永豐查詢一次（權益數等以永豐為準）
// - 證券未實現損益直接用永豐 API 回傳值；期權帳務只在 05:00／08:45／13:45／14:45 查詢（期貨商限制），未實現損益用即時價推算
// - 期權部位的代碼格式與行情代碼不同（例：TXO20260620200C = 商品 + 年月 + 履約價 + C/P），
//   用 mapFutPositions() 對應到實際合約後訂閱即時成交；期權未實現損益用均價與現價推算（帳務只在固定時段查詢）
import { fGate } from './fgate';
import { hub, keyOf } from './hub';
import { type Expiry, loadTxoExpiries } from './optchain';
import { fin, LS, normDate, tpeToday } from './util';
import type { Account, Contract, OptContract } from '../types';

/** 每點價值（元）：台指期 200、小台 50、微台 10、臺指選擇權 50 */
const MULT: Record<string, number> = { TXF: 200, MXF: 50, TMF: 10, TXO: 50 };
const multOf = (root: string) => MULT[root] ?? (/^TX[0-9A-Z]$/.test(root) ? 50 : NaN);

export interface MappedPos {
  contract: Contract;
  kind: 'fut' | 'opt';
  mult: number;
  opt?: OptContract;
  expiry?: Expiry;
}
export interface Settlement { date: string; amount: number; T: number }

export interface Margin {
  equity: number; available_margin: number; initial_margin: number; maintenance_margin: number;
  risk_indicator: number; future_open_position: number; option_open_position: number;
  today_balance: number; yesterday_balance: number;
}
export interface Position {
  code: string; direction: 'Buy' | 'Sell' | string; quantity: number; price: number; last_price: number; pnl: number;
  yd_quantity?: number; // 昨日庫存數量（今天新買的＝quantity − yd_quantity）
}
interface Realized { pnl: number }
export interface RealizedRow { code: string; date: string; quantity: number; pnl: number; direction?: string; account: 'F' | 'S' }

export interface AccountState {
  ready: boolean;
  fAccount?: Account; sAccount?: Account;
  margin?: Margin;
  futPos: Position[];
  stkPos: Position[];
  settlements: Settlement[];
  realizedF: number; realizedS: number;
  /** 期權帳務最後查詢時間（epoch 毫秒；只在固定時段查詢） */
  fQueriedAt: number;
  errors: Partial<Record<'accounts' | 'margin' | 'futPos' | 'stkPos' | 'realized', string>>;
  updatedAt: number;
}

/**
 * 期權（F）帳務查詢時段：期貨商通知查詢次數過多（2026-11-27）→ 只在台北時間
 * 05:00、08:45、13:45、14:45 各查一次（含啟動時：上一個時段之後沒查過才查）。
 * 結果存 localStorage（mw.acctF），多個分頁共用、重新整理也不會再查。
 * 證券（S）帳務照舊每 15 秒。
 */
const F_SLOTS = [5 * 60, 8 * 60 + 45, 13 * 60 + 45, 14 * 60 + 45];
export const F_SLOT_TEXT = '05:00、08:45、13:45、14:45';
/** 現在之前最近一個查詢時段（epoch 毫秒） */
export function lastFSlot(now = Date.now()): number {
  const tp = now + 8 * 3600_000;
  const day0 = Math.floor(tp / 86400_000) * 86400_000;
  for (let d = 0; d < 4; d++) {
    for (const m of [...F_SLOTS].reverse()) {
      const t = day0 - d * 86400_000 + m * 60_000 - 8 * 3600_000;
      if (t <= now) return t;
    }
  }
  return 0;
}
interface FCache { at: number; day: string; margin?: Margin; futPos: Position[]; realizedF: number; errors?: AccountState['errors'] }

const body = (a: Account, extra: Record<string, unknown> = {}) =>
  ({ account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id, ...extra });

class AccountService {
  state: AccountState = { ready: false, futPos: [], stkPos: [], settlements: [], realizedF: NaN, realizedS: NaN, fQueriedAt: 0, errors: {}, updatedAt: 0 };
  private fBusy = false;
  /** 期權部位代碼 → 實際合約 */
  readonly mapped = new Map<string, MappedPos>();
  readonly names = LS.getJSON<Record<string, string>>('names', {});
  private expiries: Expiry[] = [];
  private expiriesAt = 0;
  private users = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<() => void>();

  use(owner: string) {
    this.users.add(owner);
    if (this.users.size > 1) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 15_000);
  }
  unuse(owner: string) {
    if (!this.users.delete(owner) || this.users.size) return;
    clearInterval(this.timer);
    hub.releaseAll('account');
    // 訂閱已全部釋放：清掉對應紀錄，下次使用時才會重新訂閱
    this.mapped.clear();
    this.stkSubs.clear();
  }
  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  async refresh() {
    const s = this.state;
    const err = (k: keyof AccountState['errors'], e: unknown) => {
      s.errors[k] = String((e as Error)?.message ?? e).slice(0, 160);
    };
    if (!s.fAccount && !s.sAccount) {
      try {
        const list = await hub.be.accounts();
        s.fAccount = list.find((a) => a.account_type === 'F');
        s.sAccount = list.find((a) => a.account_type === 'S');
        delete s.errors.accounts;
      } catch (e) { err('accounts', e); }
    }
    const today = tpeToday();
    const jobs: Promise<void>[] = [];
    if (s.fAccount) jobs.push(this.refreshF(s.fAccount, today));
    if (s.sAccount) {
      const a = s.sAccount;
      jobs.push(hub.be.portfolio<Position[]>('position_unit', body(a)).then((p) => {
        s.stkPos = p ?? [];
        delete s.errors.stkPos;
        this.subscribeStocks();
      }, (e) => err('stkPos', e)));
      jobs.push(hub.be.portfolio<Realized[]>('profit_loss', body(a, { begin_date: today, end_date: today }))
        .then((r) => { s.realizedS = (r ?? []).reduce((x, y) => x + (y.pnl || 0), 0); }, (e) => err('realized', e)));
      jobs.push(hub.be.portfolio<Settlement[]>('settlements', body(a)).then((r) => { s.settlements = r ?? []; }, () => undefined));
    }
    await Promise.all(jobs);
    s.ready = true;
    s.updatedAt = Date.now();
    this.emit();
  }

  /** 期權帳務：先用快取；上一個時段之後沒查過（任何分頁都沒查過）才真的查詢 */
  private async refreshF(f: Account, today: string) {
    const s = this.state;
    const c = LS.getJSON<FCache | null>('acctF', null);
    if (c && c.at > s.fQueriedAt) {              // 快取（可能是其他分頁剛查的）
      s.margin = c.margin; s.futPos = c.futPos ?? []; s.realizedF = c.day === today ? c.realizedF : NaN;
      s.fQueriedAt = c.at;
      for (const k of ['margin', 'futPos'] as const) { if (c.errors?.[k]) s.errors[k] = c.errors[k]; else delete s.errors[k]; }
    }
    // 多個分頁同時開著：用 localStorage 的「查詢中」標記，同一時段只有一個分頁會查
    const lock = Number(LS.get('acctFLock') ?? 0);
    if (!this.fBusy && (!c || c.at < lastFSlot()) && Date.now() - lock > 60_000) {
      LS.set('acctFLock', String(Date.now()));
      this.fBusy = true;
      const errs: AccountState['errors'] = {};
      const er = (k: keyof AccountState['errors']) => (e: unknown) => { errs[k] = String((e as Error)?.message ?? e).slice(0, 160); };
      try {
        // 唯一允許查詢期權帳務的地方：閘門只在這一輪同步發出請求時打開（core/fgate.ts）
        const [m, p, r] = await fGate.run(() => Promise.all([
          hub.be.portfolio<Margin>('margin', body(f)).catch(er('margin')),
          hub.be.portfolio<Position[]>('position_unit', body(f)).catch(er('futPos')),
          hub.be.portfolio<Realized[]>('profit_loss', body(f, { begin_date: today, end_date: today })).catch(er('realized')),
        ]));
        const next: FCache = { at: Date.now(), day: today, margin: m ?? c?.margin, futPos: p ?? c?.futPos ?? [],
          realizedF: r ? r.reduce((x, y) => x + (y.pnl || 0), 0) : c?.day === today ? c.realizedF : NaN, errors: errs };
        LS.setJSON('acctF', next);                  // 失敗也記時間：下一個時段再查，不重複打 API
        s.margin = next.margin; s.futPos = next.futPos; s.realizedF = next.realizedF; s.fQueriedAt = next.at;
        for (const k of ['margin', 'futPos'] as const) { if (errs[k]) s.errors[k] = errs[k]; else delete s.errors[k]; }
      } finally { this.fBusy = false; LS.set('acctFLock', '0'); }
    }
    await this.mapFutPositions();                  // 只用行情資料對應合約，不查帳務
  }

  /** 已實現損益（自選期間）：只查證券。期權帳務只在固定時段查詢（期貨商限制），自選期間一律不查 */
  async queryRealized(begin: string, end: string): Promise<RealizedRow[]> {
    const s = this.state;
    const out: RealizedRow[] = [];
    const q = async (a: Account | undefined, kind: 'S') => {
      if (!a) return;
      const rows = await hub.be.portfolio<Record<string, unknown>[]>('profit_loss', body(a, { begin_date: begin, end_date: end })) ?? [];
      for (const r of rows) {
        out.push({ code: String(r.code ?? ''), date: normDate(r.date),
          quantity: Number(r.quantity ?? 0), pnl: Number(r.pnl ?? 0), direction: r.direction as string | undefined, account: kind });
      }
    };
    await q(s.sAccount, 'S');
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 期權部位代碼對應到實際合約，並訂閱即時成交 */
  private async mapFutPositions() {
    const codes = new Set(this.state.futPos.map((p) => p.code));
    for (const [code, m] of [...this.mapped]) {
      if (!codes.has(code)) { hub.release('account', m.contract, ['Tick']); this.mapped.delete(code); }
    }
    const todo = [...codes].filter((c) => !this.mapped.has(c));
    if (!todo.length) return;
    if (Date.now() - this.expiriesAt > 10 * 60_000) {
      this.expiries = await loadTxoExpiries().catch(() => this.expiries);
      this.expiriesAt = Date.now();
    }
    for (const code of todo) {
      const m = await this.mapOne(code).catch(() => null);
      if (!m) continue;
      this.mapped.set(code, m);
      hub.acquire('account', m.contract, ['Tick']);
    }
    const ms = [...this.mapped.values()];
    await hub.loadSnapshots(ms.map((m) => m.contract));
  }

  private async mapOne(code: string): Promise<MappedPos | null> {
    // 選擇權：TXO 202612 28000 C
    const o = code.match(/^([A-Z0-9]{3})(\d{6})(\d+(?:\.\d+)?)([CP])$/);
    if (o) {
      const [, root, ym, k, r] = o;
      for (const e of this.expiries) {
        const hit = e.list.find((x) => x.root === root && x.delivery_month === ym && x.strike === Number(k) && x.right === r);
        if (hit) return { contract: hit, kind: 'opt', mult: multOf(root), opt: hit, expiry: e };
      }
      return null;
    }
    // 期貨：可能是行情代碼（TXFL6）或 商品＋年月（TXF202612）
    const root = code.slice(0, 3);
    const list = await hub.be.futuresList(root);
    const ym = code.match(/^[A-Z0-9]{3}(\d{6})$/)?.[1];
    const hit = list.find((f) => f.code === code) ?? (ym ? list.find((f) => f.delivery_month === ym) : undefined);
    return hit ? { contract: hit, kind: 'fut', mult: multOf(root) } : null;
  }

  /**
   * 期權部位未實現損益：用庫存均價與即時成交價推算（點差 × 口數 × 乘數，未扣手續費與期交稅）。
   * 期權帳務只在固定時段查詢（API 的 pnl 不即時），所以不用 API 的 pnl；對應不到合約或沒有報價時才退回 API 值。
   */
  futPnl(p: Position): number {
    const m = this.mapped.get(p.code);
    const last = m ? hub.quotes.get(keyOf(m.contract))?.last : undefined;
    if (!m || !fin(m.mult) || !fin(last ?? NaN) || !fin(p.price)) return fin(p.pnl) ? p.pnl : NaN;
    const sign = p.direction === 'Sell' ? -1 : 1;
    return sign * (last! - p.price) * p.quantity * m.mult;
  }

  /** 股票名稱（快取於 localStorage，與權值股共用） */
  nameOf(code: string): string {
    if (this.names[code]) return this.names[code];
    this.names[code] = code;
    hub.be.contractInfo({ security_type: 'STK', exchange: 'TSE', code }).then((i) => {
      this.names[code] = i.name; LS.setJSON('names', this.names); this.emit();
    }).catch(() => undefined);
    return code;
  }

  /** 庫存股票訂閱即時成交，未實現損益即時跳動 */
  private stkSubs = new Set<string>();
  private subscribeStocks() {
    const want = new Set(this.state.stkPos.map((p) => p.code));
    const stk = (code: string): Contract => ({ security_type: 'STK', exchange: 'TSE', code });
    for (const c of this.stkSubs) if (!want.has(c)) { hub.release('account', stk(c), ['Tick']); this.stkSubs.delete(c); }
    for (const c of want) {
      if (this.stkSubs.has(c)) continue;
      this.stkSubs.add(c);
      // 上櫃股票用 TSE 訂閱會失敗：先查實際交易所；同時載入快照取得參考價（今日漲跌）
      hub.be.resolve(c, 'STK').catch(() => stk(c)).then((ct) => {
        hub.acquire('account', ct, ['Tick']);
        hub.loadSnapshots([ct]);
      });
    }
  }

  /** 證券部位的即時未實現損益（張數 × 1000 股） */
  /** 證券未實現損益：直接用永豐帳務 API 的 pnl（使用者指定以 API 為準，約 15 秒更新）；API 沒給時才用價差估算 */
  stockPnl(p: Position): number {
    if (fin(p.pnl)) return p.pnl;
    const last = hub.quotes.get(p.code)?.last;
    if (!fin(last ?? NaN) || !fin(p.price)) return NaN;
    return (p.direction === 'Sell' ? -1 : 1) * (last! - p.price) * p.quantity * 1000;
  }

  /** 證券「今日」損益：昨日已持有的部分以參考價（昨收）計，今天新買的部分以成本計（docs/ai/decisions.md） */
  stockDayPnl(p: Position): number {
    const x = hub.quotes.get(p.code);
    const last = x?.last ?? p.last_price, ref = x?.ref ?? NaN;
    if (!fin(last)) return NaN;
    const sg = p.direction === 'Sell' ? -1 : 1;
    const yd = fin(p.yd_quantity ?? NaN) ? Math.min(p.yd_quantity!, p.quantity) : p.quantity;
    const fromYd = fin(ref) ? (last - ref) * yd : NaN;
    const fromToday = (last - p.price) * (p.quantity - yd);
    if (!fin(fromYd)) return yd === 0 ? sg * fromToday * 1000 : NaN;
    return sg * (fromYd + fromToday) * 1000;
  }

  /** 期權部位「今日」變動（以參考價計；對應不到合約時無法計算） */
  futDayPnl(p: Position): number {
    const m = this.mapped.get(p.code);
    const x = m ? hub.quotes.get(keyOf(m.contract)) : undefined;
    if (!m || !x || !fin(x.last) || !fin(x.ref) || !fin(m.mult)) return NaN;
    return (p.direction === 'Sell' ? -1 : 1) * (x.last - x.ref) * p.quantity * m.mult;
  }

  totals() {
    const s = this.state;
    const unrealF = s.futPos.reduce((x, p) => x + (this.futPnl(p) || 0), 0);
    const unrealS = s.stkPos.reduce((x, p) => x + this.stockPnl(p), 0);
    const sum = (arr: number[]) => arr.reduce((a, v) => a + (fin(v) ? v : 0), 0);
    const dayF = sum(s.futPos.map((p) => this.futDayPnl(p)));
    const dayS = sum(s.stkPos.map((p) => this.stockDayPnl(p)));
    return { unrealF, unrealS, realizedF: s.realizedF, realizedS: s.realizedS, dayF, dayS };
  }
}

export const account = new AccountService();
