// 透過本機 shioaji server（HTTP API + SSE）取得資料。
// 金鑰與登入由 shioaji server 的 .env 處理，前端完全不碰金鑰。
import type {
  Backend, Bar, BidAsk, Contract, Handlers, IndexQuote, Info, QuoteType,
  OptContract, OptRoot, ScannerType, ScanRow, SecType, Snap, Tick,
} from './types';

const BASE = '/api/v1';

async function req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
    };
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
        delivery_date: String(o.delivery_date).slice(0, 10),
        delivery_month: String(o.delivery_month ?? ''),
        reference: num(o.reference),
      }));
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
        high: num(d.High), low: num(d.Low), amountSum: num(d.AmountSum),
        raise: num(d.Raise), raiseStop: num(d.RaiseStop), fall: num(d.Fall),
        fallStop: num(d.FallStop), flat: num(d.Flat),
      }));
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
