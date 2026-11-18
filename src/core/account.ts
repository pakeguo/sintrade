// 帳務服務（唯讀）：期權保證金、未平倉部位、證券庫存、今日已實現損益
//
// - 每 15 秒向永豐查詢一次（權益數等以永豐為準）
// - 證券庫存的未實現損益用即時行情計算，價格一動就跟著跳（使用者選「即時跳動」）
// - 期權部位的代碼格式與行情代碼不同（例：TXO20260620200C = 商品 + 年月 + 履約價 + C/P），
//   用 mapFutPositions() 對應到實際合約後訂閱即時成交，損益也即時跳動；對應不到時用永豐回傳值
import { hub, keyOf } from './hub';
import { type Expiry, loadTxoExpiries } from './optchain';
import { fin, LS, tpeToday } from './util';
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
  errors: Partial<Record<'accounts' | 'margin' | 'futPos' | 'stkPos' | 'realized', string>>;
  updatedAt: number;
}

const body = (a: Account, extra: Record<string, unknown> = {}) =>
  ({ account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id, ...extra });

class AccountService {
  state: AccountState = { ready: false, futPos: [], stkPos: [], settlements: [], realizedF: NaN, realizedS: NaN, errors: {}, updatedAt: 0 };
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
    if (s.fAccount) {
      const f = s.fAccount;
      jobs.push(hub.be.portfolio<Margin>('margin', body(f)).then((m) => { s.margin = m; delete s.errors.margin; }, (e) => err('margin', e)));
      jobs.push(hub.be.portfolio<Position[]>('position_unit', body(f)).then(async (p) => {
        s.futPos = p ?? [];
        delete s.errors.futPos;
        await this.mapFutPositions();
      }, (e) => err('futPos', e)));
      jobs.push(hub.be.portfolio<Realized[]>('profit_loss', body(f, { begin_date: today, end_date: today }))
        .then((r) => { s.realizedF = (r ?? []).reduce((x, y) => x + (y.pnl || 0), 0); }, (e) => err('realized', e)));
    }
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

  /** 已實現損益（自選期間），期權與證券合併 */
  async queryRealized(begin: string, end: string): Promise<RealizedRow[]> {
    const s = this.state;
    const out: RealizedRow[] = [];
    const q = async (a: Account | undefined, kind: 'F' | 'S') => {
      if (!a) return;
      const rows = await hub.be.portfolio<Record<string, unknown>[]>('profit_loss', body(a, { begin_date: begin, end_date: end }));
      for (const r of rows ?? []) {
        out.push({ code: String(r.code ?? ''), date: String(r.date ?? '').slice(0, 10).replace(/\//g, '-'),
          quantity: Number(r.quantity ?? 0), pnl: Number(r.pnl ?? 0), direction: r.direction as string | undefined, account: kind });
      }
    };
    await Promise.all([q(s.fAccount, 'F'), q(s.sAccount, 'S')]);
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

  /** 期權部位的即時未實現損益 */
  futPnl(p: Position): number {
    const m = this.mapped.get(p.code);
    const last = m ? hub.quotes.get(keyOf(m.contract))?.last : undefined;
    if (!m || !fin(m.mult) || !fin(last ?? NaN) || !fin(p.price)) return p.pnl;
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
  stockPnl(p: Position): number {
    const last = hub.quotes.get(p.code)?.last;
    if (!fin(last ?? NaN) || !fin(p.price)) return p.pnl;
    const sign = p.direction === 'Sell' ? -1 : 1;
    return sign * (last! - p.price) * p.quantity * 1000;
  }

  totals() {
    const s = this.state;
    const unrealF = s.futPos.reduce((x, p) => x + (this.futPnl(p) || 0), 0);
    const unrealS = s.stkPos.reduce((x, p) => x + this.stockPnl(p), 0);
    return { unrealF, unrealS, realizedF: s.realizedF, realizedS: s.realizedS };
  }
}

export const account = new AccountService();
