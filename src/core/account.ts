// 帳務服務（唯讀）：期權保證金、未平倉部位、證券庫存、今日已實現損益
//
// - 每 15 秒向永豐查詢一次（權益數等以永豐為準）
// - 證券庫存的未實現損益用即時行情計算，價格一動就跟著跳（使用者選「即時跳動」）
// - 期權部位的代碼格式與行情代碼不同（例：TXO20260620200C），目前使用永豐回傳的損益，15 秒更新
import { hub } from './hub';
import { fin, tpeToday } from './util';
import type { Account, Contract } from '../types';

export interface Margin {
  equity: number; available_margin: number; initial_margin: number; maintenance_margin: number;
  risk_indicator: number; future_open_position: number; option_open_position: number;
  today_balance: number; yesterday_balance: number;
}
export interface Position {
  code: string; direction: 'Buy' | 'Sell' | string; quantity: number; price: number; last_price: number; pnl: number;
}
interface Realized { pnl: number }

export interface AccountState {
  ready: boolean;
  fAccount?: Account; sAccount?: Account;
  margin?: Margin;
  futPos: Position[];
  stkPos: Position[];
  realizedF: number; realizedS: number;
  errors: Partial<Record<'accounts' | 'margin' | 'futPos' | 'stkPos' | 'realized', string>>;
  updatedAt: number;
}

const body = (a: Account, extra: Record<string, unknown> = {}) =>
  ({ account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id, ...extra });

class AccountService {
  state: AccountState = { ready: false, futPos: [], stkPos: [], realizedF: NaN, realizedS: NaN, errors: {}, updatedAt: 0 };
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
      jobs.push(hub.be.portfolio<Position[]>('position_unit', body(f)).then((p) => { s.futPos = p ?? []; delete s.errors.futPos; }, (e) => err('futPos', e)));
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
    }
    await Promise.all(jobs);
    s.ready = true;
    s.updatedAt = Date.now();
    this.emit();
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
      // 上櫃股票用 TSE 訂閱會失敗：先查實際交易所
      hub.be.resolve(c, 'STK').then((ct) => hub.acquire('account', ct, ['Tick'])).catch(() => hub.acquire('account', stk(c), ['Tick']));
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
    const unrealF = s.futPos.reduce((x, p) => x + (p.pnl || 0), 0);
    const unrealS = s.stkPos.reduce((x, p) => x + this.stockPnl(p), 0);
    return { unrealF, unrealS, realizedF: s.realizedF, realizedS: s.realizedS };
  }
}

export const account = new AccountService();
