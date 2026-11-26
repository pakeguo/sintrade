// 透過本機 shioaji server（HTTP API + SSE）取得資料。
// 金鑰與登入由 shioaji server 的 .env 處理，前端完全不碰金鑰。
import type {
  Account, ComponentsProjection, ComponentsUpdate,
  Backend, Bar, BidAsk, Contract, Handlers, IndexQuote, Info, QuoteType,
  FutContract, OptContract, OptRoot, ScannerType, ScanRow, SecType, Snap, Tick,
} from './types';

import { isOrderUrl, OrderBlockedError } from './core/guard';
import { normDate } from './core/util';

const BASE = '/api/v1';

async function req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // 下單防堵（core/guard.ts）：就算日後有人在這裡加了下單呼叫，也會在送出前被擋下
  if (isOrderUrl(BASE + path)) throw new OrderBlockedError(BASE + path);
  // 一律限時：server 沒回應時不會無限等待（pitfalls #24）；歷史 K 棒資料量大，給較長時間
  const ms = /\/data\/(kbars|ticks)/.test(path) ? 90_000 : 30_000;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new Error(`${method} ${path} 逾時（${ms / 1000} 秒沒有回應）`);
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));

/** "2026-05-21" 或 "2026/05/21" + "09:18:31.867" → 台北時間當 UTC 的秒數 */
export function toSec(date: string, time = '00:00:00'): number {
  const [y, m, d] = date.split(/[-/]/).map(Number);
  const [hh, mm, ss] = time.split(':');
  return Date.UTC(y, m - 1, d, Number(hh), Number(mm), Math.floor(Number(ss ?? 0))) / 1000;
}

export function isoToSec(iso: string): number {
  const [date, time] = iso.split('T');
  return toSec(date, time);
}

const ref = (c: Contract) => ({
  security_type: c.security_type,
  exchange: c.exchange,
  code: c.code,
  ...(c.target_code ? { target_code: c.target_code } : {}),
});

type Columnar = Record<string, unknown[]>;

export class LiveBackend implements Backend {
  readonly kind = 'live' as const;
  private es: EventSource | null = null;
  private subs = new Map<string, { c: Contract; q: QuoteType }>();
  private enriched = new Map<string, ComponentsProjection>();
  private retry = 1000;
  private lastBeat = 0;

  async info() {
    const r = await req<Record<string, unknown>>('GET', '/info');
    return { simulation: Boolean(r.simulation) };
  }

  resolve(code: string, sec?: SecType) {
    const qs = new URLSearchParams({ region: 'TW' });
    if (sec) qs.set('security_type', sec);
    return req<Contract>('GET', `/data/contracts/${encodeURIComponent(code.trim().toUpperCase())}?${qs}`);
  }

  async contractInfo(c: Contract): Promise<Info> {
    const qs = new URLSearchParams({ region: 'TW', security_type: c.security_type });
    const r = await req<Record<string, unknown>>('GET', `/data/contracts/${encodeURIComponent(c.code)}/info?${qs}`);
    return {
      name: String(r.name ?? c.code).trim(),
      reference: num(r.reference),
      limit_up: num(r.limit_up),
      limit_down: num(r.limit_down),
      category: r.category != null ? String(r.category) : undefined,
    };
  }

  async stockList(): Promise<Contract[]> {
    // 不帶 page/page_size 會一次回傳全部（docs/ai/shioaji-api.md）
    const r = await req<{ contracts?: Contract[] } | Contract[]>('GET', '/data/contracts?security_type=STK&region=TW');
    return Array.isArray(r) ? r : r.contracts ?? [];
  }

  async snapshots(cs: Contract[]): Promise<Snap[]> {
    if (!cs.length) return [];
    const out: Snap[] = [];
    for (let i = 0; i < cs.length; i += 400) {
      const part = await req<Record<string, unknown>[]>('POST', '/data/snapshots', {
        contracts: cs.slice(i, i + 400).map(ref),
      });
      for (const s of part) {
        out.push({
          code: String(s.code), open: num(s.open), high: num(s.high), low: num(s.low),
          close: num(s.close), change_price: num(s.change_price),
          total_volume: num(s.total_volume), total_amount: num(s.total_amount),
          buy_price: num(s.buy_price), sell_price: num(s.sell_price),
          volume_ratio: num(s.volume_ratio), yesterday_volume: num(s.yesterday_volume),
        });
      }
    }
    return out;
  }

  async kbars(c: Contract, start: string, end: string): Promise<Bar[]> {
    const r = await req<Columnar>('POST', '/data/kbars', { contract: ref(c), start, end });
    const dt = (r.datetime ?? []) as string[];
    return dt.map((d, i) => ({
      t: isoToSec(d),
      o: num(r.Open[i]), h: num(r.High[i]), l: num(r.Low[i]), c: num(r.Close[i]), v: num(r.Volume[i]),
    }));
  }

  async recentTicks(c: Contract, date: string, count: number): Promise<Tick[]> {
    const r = await req<Columnar>('POST', '/data/ticks', {
      contract: ref(c), date, query_type: 'LastCount', last_cnt: count,
    });
    const dt = (r.datetime ?? []) as string[];
    return dt.map((d, i) => ({
      code: c.code, t: isoToSec(d), price: num(r.close[i]), vol: num(r.volume[i]),
      totalVol: NaN, side: (Number(r.tick_type[i]) || 0) as 0 | 1 | 2,
    }));
  }

  async ticksDay(c: Contract, date: string): Promise<Tick[]> {
    const r = await req<Columnar>('POST', '/data/ticks', { contract: ref(c), date, query_type: 'AllDay' });
    const dt = (r.datetime ?? []) as string[];
    return dt.map((d, i) => ({
      code: c.code, t: isoToSec(d), price: num(r.close[i]), vol: num(r.volume[i]),
      totalVol: NaN, side: (Number(r.tick_type[i]) || 0) as 0 | 1 | 2,
    }));
  }

  async scanner(type: ScannerType, ascending: boolean, count: number): Promise<ScanRow[]> {
    const r = await req<Record<string, unknown>[]>('POST', '/data/scanner', {
      scanner_type: type, ascending, count,
    });
    return r.map((s) => {
      const close = num(s.close), chg = num(s.change_price);
      const refPrice = close - chg;
      return {
        code: String(s.code), name: String(s.name ?? '').trim(), close, chg,
        pct: refPrice ? (chg / refPrice) * 100 : 0,
        volume: num(s.total_volume), amount: num(s.total_amount),
      };
    });
  }

  async futuresList(root: string): Promise<FutContract[]> {
    const r = await req<unknown>('GET', `/data/contracts/futures?root=${encodeURIComponent(root)}&region=TW`);
    const list = (Array.isArray(r) ? r : ((r as { contracts?: unknown[] }).contracts ?? [])) as Record<string, unknown>[];
    return list
      .filter((f) => f.code && f.delivery_date && !/R\d$/.test(String(f.code)))
      .map((f) => ({
        security_type: 'FUT' as const,
        exchange: String(f.exchange ?? 'TAIFEX'),
        code: String(f.code),
        target_code: null,
        name: String(f.name ?? f.code),
        delivery_date: normDate(f.delivery_date),
        delivery_month: String(f.delivery_month ?? ''),
      }));
  }

  optionRoots() {
    return req<OptRoot[]>('GET', '/data/contracts/options/roots?region=TW');
  }

  async optionChain(root: string): Promise<OptContract[]> {
    const r = await req<unknown>('GET', `/data/contracts/options?root=${encodeURIComponent(root)}&region=TW`);
    const list = (Array.isArray(r) ? r : ((r as { contracts?: unknown[] }).contracts ?? [])) as Record<string, unknown>[];
    return list
      .filter((o) => o.code && o.strike_price != null && o.delivery_date)
      .map((o) => ({
        security_type: 'OPT' as const,
        exchange: String(o.exchange ?? 'TAIFEX'),
        code: String(o.code),
        target_code: null,
        name: String(o.name ?? o.code),
        root: String(o.root ?? root),
        strike: num(o.strike_price),
        right: (String(o.option_right ?? '').toUpperCase().startsWith('P') ? 'P' : 'C') as 'C' | 'P',
        delivery_date: normDate(o.delivery_date),
        delivery_month: String(o.delivery_month ?? ''),
        reference: num(o.reference),
      }));
  }

  accounts() {
    return req<Account[]>('GET', '/auth/accounts');
  }

  /** 帳務唯讀查詢：path 例如 'margin'、'position_unit'、'profit_loss' */
  portfolio<T>(path: string, body: Record<string, unknown>) {
    if (!/^[a-z_]+$/.test(path)) throw new Error('bad portfolio path');
    return req<T>('POST', `/portfolio/${path}`, body);
  }

  private ixBody(p: ComponentsProjection) {
    return { index: { security_type: 'IND', exchange: 'TSE', code: 'IX0001', target_code: null }, projection: p };
  }
  async subscribeComponents(p: ComponentsProjection) {
    const k = 'components:' + JSON.stringify(p);
    if (this.enriched.has(k)) return;
    this.enriched.set(k, p);
    await req('POST', '/stream/subscribe/index_components', this.ixBody(p)).catch((e) => { this.enriched.delete(k); throw e; });
  }
  async unsubscribeComponents(p: ComponentsProjection) {
    const k = 'components:' + JSON.stringify(p);
    if (!this.enriched.delete(k)) return;
    await req('POST', '/stream/unsubscribe/index_components', this.ixBody(p)).catch(() => undefined);
  }

  private key(c: Contract, q: QuoteType) {
    return `${c.security_type}:${c.code}:${q}`;
  }

  async subscribe(c: Contract, q: QuoteType) {
    const k = this.key(c, q);
    if (this.subs.has(k)) return;
    this.subs.set(k, { c, q });
    try {
      const r = await req<{ success?: boolean; message?: string }>('POST', '/stream/subscribe', { ...ref(c), quote_type: q });
      if (r && r.success === false) throw new Error(r.message || '訂閱失敗');
    } catch (e) {
      this.subs.delete(k);
      throw e;
    }
  }

  async unsubscribe(c: Contract, q: QuoteType) {
    const k = this.key(c, q);
    if (!this.subs.delete(k)) return;
    await req('POST', '/stream/unsubscribe', { ...ref(c), quote_type: q }).catch(() => undefined);
  }

  connect(h: Handlers) {
    let everDown = false;
    const open = () => {
      h.status('connecting');
      const es = new EventSource(`${BASE}/stream/data?region=TW`);
      this.es = es;
      es.onopen = () => {
        this.retry = 1000;
        this.lastBeat = Date.now();
        h.status('live');
        if (everDown) {
          // server 可能重啟過：SSE 斷線重連後要重新訂閱
          everDown = false;
          const all = [...this.subs.values()];
          this.subs.clear();
          for (const s of all) this.subscribe(s.c, s.q).catch(() => undefined);
          const ens = [...this.enriched.values()];
          this.enriched.clear();
          for (const p of ens) this.subscribeComponents(p).catch(() => undefined);
        }
      };
      es.onerror = () => {
        es.close();
        everDown = true;
        h.status('down');
        setTimeout(open, this.retry);
        this.retry = Math.min(this.retry * 2, 15000);
      };
      const on = (name: string, fn: (d: Record<string, unknown>) => void) =>
        es.addEventListener(name, (ev) => {
          this.lastBeat = Date.now();
          try { fn(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore malformed */ }
        });
      const tick = (d: Record<string, unknown>) => h.tick({
        code: String(d.code), t: toSec(String(d.date), String(d.time)),
        price: num(d.close), vol: num(d.volume), totalVol: num(d.total_volume),
        side: (Number(d.tick_type) || 0) as 0 | 1 | 2,
        open: num(d.open), high: num(d.high), low: num(d.low),
        bidSideVol: num(d.bid_side_total_vol), askSideVol: num(d.ask_side_total_vol),
        simtrade: Boolean(d.simtrade),
      });
      const bidask = (d: Record<string, unknown>) => {
        const zip = (p: unknown, v: unknown) =>
          ((p as unknown[]) ?? []).map((x, i) => [num(x), num((v as unknown[])[i])] as [number, number]);
        h.bidask({
          code: String(d.code), bids: zip(d.bid_price, d.bid_volume),
          asks: zip(d.ask_price, d.ask_volume), simtrade: Boolean(d.simtrade),
        });
      };
      on('tick_stk', tick);
      on('tick_fop', tick);
      on('bidask_stk', bidask);
      on('bidask_fop', bidask);
      on('quote_idx', (d) => h.index({
        code: String(d.code), t: toSec(String(d.Date), String(d.Time)),
        close: num(d.Close), reference: num(d.Reference), open: num(d.Open),
        high: num(d.High), low: num(d.Low), amountSum: num(d.AmountSum), prevAmountSum: num(d.PrevAmountSum),
        raise: num(d.Raise), raiseStop: num(d.RaiseStop), fall: num(d.Fall),
        fallStop: num(d.FallStop), flat: num(d.Flat),
      }));
      on('index_components', (d) => {
        const entries = Array.isArray(d.entries) ? (d.entries as Record<string, unknown>[]).map((e) => ({
          code: String(e.code), category: String(e.category ?? ''), price: num(e.price), reference: num(e.reference),
          pct: num(e.pct_chg), value: num(e.value), weightPpm: num(e.reference_weight_ppm),
        })) : undefined;
        const groups = Array.isArray(d.groups) ? (d.groups as Record<string, unknown>[]).map((g) => ({
          category: String(g.category), name: String(g.name ?? g.category), count: num(g.item_count), value: num(g.value),
        })) : undefined;
        h.components({ projection: d.projection as ComponentsProjection, entries, groups, simtrade: Boolean(d.simtrade),
          date: d.date ? String(d.date).replace(/\//g, '-') : undefined, time: d.time ? String(d.time).slice(0, 8) : undefined } as ComponentsUpdate);
      });
      on('heartbeat', () => h.status('live'));
    };
    open();
    // 連線看似開著但長時間沒有任何事件 → 重連
    setInterval(() => {
      if (this.es && this.es.readyState === EventSource.OPEN && Date.now() - this.lastBeat > 90_000) {
        this.es.onerror?.(new Event('error'));
      }
    }, 15_000);
  }
}
