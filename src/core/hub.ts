// 行情中心：所有頁面共用的連線、報價快取、訂閱管理（引用計數）、加權指數與台指期近月（含自動換月）
import { LiveBackend } from '../api';
import { DemoBackend } from '../mock';
import type { Backend, BidAsk, ComponentsUpdate, ConnStatus, Contract, IndexQuote, QuoteType, Tick } from '../types';
import { fin, isLive } from './util';

export type Env = 'sim' | 'prod' | 'demo';

/** 單一商品的即時報價快取 */
export interface Q {
  last: number; ref: number; vol: number; high: number; low: number; open: number;
  bids: [number, number][]; asks: [number, number][];
  bidSideVol: number; askSideVol: number;  // 內外盤累計量
  snapBid: number; snapAsk: number;        // 快照帶的最佳買賣價（沒有即時五檔時用）
  flash: number; dir: 0 | 1 | -1;           // 最近一次價格變動的時間與方向（畫面閃爍用）
}

interface Events {
  tick: Tick;
  bidask: BidAsk;
  index: IndexQuote;
  status: ConnStatus;
  /** 台指期換月：{ next, prev } */
  fut: { next: Contract; prev: Contract | null };
  /** 權值股／類股加值串流 */
  components: ComponentsUpdate;
  /** 任何報價有變動（頁面據此標記需要重繪） */
  change: void;
}

export const keyOf = (c: Contract) => c.target_code || c.code;

class Hub {
  be!: Backend;
  env: Env = 'demo';
  status: ConnStatus = 'connecting';
  readonly quotes = new Map<string, Q>();
  idx: IndexQuote | null = null;
  /** 所有收到的指數（IX0001 加權、IX0043 櫃買…） */
  readonly indices = new Map<string, IndexQuote>();
  ixContract: Contract = { security_type: 'IND', exchange: 'TSE', code: 'IX0001' };
  fut: Contract | null = null;   // 目前的台指期近月（自行挑選，不依賴 TXFR1）
  futKey = '';
  futName = '台指期 近月';

  private listeners = new Map<keyof Events, Set<(v: never) => void>>();
  private owners = new Map<string, Set<string>>();  // `${code}|${quoteType}` → 使用中的頁面
  private subContracts = new Map<string, Contract>();

  // ── 事件 ──
  on<K extends keyof Events>(k: K, fn: (v: Events[K]) => void): () => void {
    let set = this.listeners.get(k);
    if (!set) { set = new Set(); this.listeners.set(k, set); }
    set.add(fn as (v: never) => void);
    return () => set!.delete(fn as (v: never) => void);
  }
  private emit<K extends keyof Events>(k: K, v: Events[K]) {
    this.listeners.get(k)?.forEach((fn) => (fn as (v: Events[K]) => void)(v));
  }

  q(code: string): Q {
    let x = this.quotes.get(code);
    if (!x) {
      x = { last: NaN, ref: NaN, vol: 0, high: NaN, low: NaN, open: NaN, bids: [], asks: [],
        bidSideVol: NaN, askSideVol: NaN, snapBid: NaN, snapAsk: NaN, flash: 0, dir: 0 };
      this.quotes.set(code, x);
    }
    return x;
  }

  // ── 啟動 ──
  async init(): Promise<{ fellBackToDemo: boolean }> {
    let fellBackToDemo = false;
    const force = new URLSearchParams(location.search).has('demo');
    if (!force) {
      const live = new LiveBackend();
      try {
        const info = await Promise.race([
          live.info(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        this.be = live;
        this.env = info.simulation ? 'sim' : 'prod';
      } catch { fellBackToDemo = true; }
    }
    if (!this.be) { this.be = new DemoBackend(); this.env = 'demo'; }

    this.be.connect({
      tick: (t) => this.onTick(t),
      bidask: (b) => this.onBidAsk(b),
      index: (i) => {
        this.indices.set(i.code, i);
        if (i.code === 'IX0001') this.idx = i;
        this.emit('index', i);
        this.emit('change', undefined);
      },
      status: (s) => { this.status = s; this.emit('status', s); },
      components: (u) => { if (!u.simtrade) { this.emit('components', u); this.emit('change', undefined); } },
    });

    // 加權指數：全程訂閱（每一頁的上方都會用到）
    this.ixContract = await this.be.resolve('IX0001', 'IND').catch(() => this.ixContract);
    this.acquire('hub', this.ixContract, ['Quote']);
    const [s] = await this.be.snapshots([this.ixContract]).catch(() => []);
    if (s && !this.idx) {
      this.idx = { code: 'IX0001', t: 0, close: s.close, reference: s.close - s.change_price, open: s.open,
        high: s.high, low: s.low, amountSum: s.total_amount, raise: NaN, raiseStop: 0, fall: NaN, fallStop: 0, flat: NaN };
    }
    return { fellBackToDemo };
  }

  // ── 即時事件 → 報價快取 ──
  private onTick(t: Tick) {
    if (t.simtrade) return; // 試撮不列入
    const x = this.q(t.code);
    if (fin(x.last) && t.price !== x.last) { x.dir = t.price > x.last ? 1 : -1; x.flash = performance.now(); }
    x.last = t.price;
    if (fin(t.totalVol)) x.vol = t.totalVol;
    if (fin(t.high ?? NaN)) x.high = t.high!;
    if (fin(t.low ?? NaN)) x.low = t.low!;
    if (fin(t.open ?? NaN)) x.open = t.open!;
    if (fin(t.bidSideVol ?? NaN)) x.bidSideVol = t.bidSideVol!;
    if (fin(t.askSideVol ?? NaN)) x.askSideVol = t.askSideVol!;
    this.emit('tick', t);
    this.emit('change', undefined);
  }
  private onBidAsk(b: BidAsk) {
    if (b.simtrade) return;
    const x = this.q(b.code);
    x.bids = b.bids; x.asks = b.asks;
    this.emit('bidask', b);
    this.emit('change', undefined);
  }

  // ── 訂閱管理：同一商品被多個頁面使用時只訂閱一次，最後一個使用者離開才退訂 ──
  acquire(owner: string, c: Contract, types: QuoteType[]) {
    for (const t of types) {
      const k = `${keyOf(c)}|${t}`;
      let set = this.owners.get(k);
      if (!set) {
        set = new Set();
        this.owners.set(k, set);
        this.subContracts.set(k, c);
        this.be.subscribe(c, t).catch((e) => console.warn('subscribe', keyOf(c), t, e));
      }
      set.add(owner);
    }
  }
  release(owner: string, c: Contract, types: QuoteType[]) {
    for (const t of types) {
      const k = `${keyOf(c)}|${t}`;
      const set = this.owners.get(k);
      if (!set?.delete(owner) || set.size) continue;
      this.owners.delete(k);
      this.subContracts.delete(k);
      this.be.unsubscribe(c, t).catch(() => undefined);
    }
  }
  releaseAll(owner: string) {
    for (const [k, set] of [...this.owners]) {
      if (!set.has(owner)) continue;
      const c = this.subContracts.get(k)!;
      this.release(owner, c, [k.split('|')[1] as QuoteType]);
    }
  }
  /** 目前訂閱數（shioaji 上限約 200） */
  get subscriptionCount() { return this.owners.size; }

  // ── 快照 ──
  async loadSnapshots(list: Contract[]) {
    if (!list.length) return;
    try {
      const snaps = await this.be.snapshots(list);
      for (const s of snaps) {
        // 連續月（TXFR1）的快照回傳 TXFR1，即時 tick 則用實際月份代碼 → 統一存到 futKey（pitfalls #2）
        const x = this.q(this.fut && (s.code === this.fut.code || s.code === this.futKey) ? this.futKey : s.code);
        if (fin(s.close) && s.close > 0) x.last = s.close;
        const r = s.close - s.change_price;
        if (fin(r) && r > 0) x.ref = r;
        x.vol = Math.max(x.vol, s.total_volume || 0);
        x.high = s.high; x.low = s.low; x.open = s.open;
        x.snapBid = s.buy_price; x.snapAsk = s.sell_price;
      }
      this.emit('change', undefined);
    } catch (e) { console.warn('snapshots', e); }
  }

  // ── 台指期近月與自動換月（pitfalls #1） ──
  /** 挑出尚未到期、最近的台指期合約；拿不到清單時才退回 TXFR1 */
  async pickFuture(): Promise<Contract & { delivery_month?: string }> {
    try {
      const list = (await this.be.futuresList('TXF')).filter((f) => isLive(f.delivery_date))
        .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
      if (list.length) return list[0];
    } catch (e) { console.warn('futuresList', e); }
    return this.be.resolve('TXFR1', 'FUT');
  }

  async setFuture(c: Contract & { delivery_month?: string }) {
    const prev = this.fut;
    if (prev && keyOf(prev) !== keyOf(c)) this.release('hub', prev, ['Tick', 'BidAsk']);
    this.fut = c;
    this.futKey = keyOf(c);
    const m = Number((c.delivery_month ?? '').slice(4, 6));
    this.futName = m ? `台指期 ${m}月` : '台指期 近月';
    this.be.contractInfo(c).then((info) => {
      const x = this.q(this.futKey);
      if (!fin(x.ref) && fin(info.reference) && info.reference > 0) { x.ref = info.reference; this.emit('change', undefined); }
    }).catch(() => undefined);
    await this.loadSnapshots([c]);
    this.acquire('hub', c, ['Tick', 'BidAsk']);
    this.emit('fut', { next: c, prev });
  }

  /** 每分鐘呼叫：結算後自動換到下個月 */
  async rollFuture() {
    try {
      const next = await this.pickFuture();
      if (this.fut && keyOf(next) !== this.futKey) {
        console.info('期貨換月', this.futKey, '→', keyOf(next));
        await this.setFuture(next);
      }
    } catch (e) { console.warn('rollFuture', e); }
  }
}

export const hub = new Hub();
