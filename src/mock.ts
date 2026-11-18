// DEMO 後端：不連 shioaji server，用隨機漫步 + Black-76 產生擬真的期權行情。
// 只用於預覽介面（網址加 ?demo=1，或連不到 server 時自動切換）。
import { price as bsPrice, yearsToExpiry } from './bs';
import type {
  Backend, Bar, Contract, FutContract, Handlers, Info, OptContract, OptRoot, QuoteType, ScanRow, Snap, Tick,
} from './types';

const tpeNow = () => new Date(Date.now() + 8 * 3600_000); // 用 UTC getter 讀台北時間
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const nowSec = () => Math.floor(tpeNow().getTime() / 1000);

interface Live {
  c: Contract; ref: number; last: number; open: number; high: number; low: number;
  totalVol: number; opt?: OptContract;
}

function nextWeekday(from: Date, wd: number, skip = 0): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + ((wd - d.getUTCDay() + 7) % 7 || 7) + skip * 7);
  return d;
}

function thirdWed(y: number, m: number): Date {
  const d = new Date(Date.UTC(y, m, 1));
  const first = (3 - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, m, 1 + first + 14));
}

const MONTH_CODE = 'ABCDEFGHIJKL';

export class DemoBackend implements Backend {
  readonly kind = 'demo' as const;
  private spot = 27850;
  private basis = 35;
  private spotRef = 27700;
  private live = new Map<string, Live>();
  private subs = new Set<string>();
  private chains = new Map<string, OptContract[]>();
  private h?: Handlers;
  private futCode: string;
  private futAlias = ''; // App 實際訂閱的台指期代碼（換月後會變），DEMO 一律對應同一份行情

  constructor() {
    const t = tpeNow();
    this.futCode = 'TXF' + MONTH_CODE[t.getUTCMonth()] + String(t.getUTCFullYear()).slice(-1);
    this.live.set('IX0001', this.mk({ security_type: 'IND', exchange: 'TSE', code: 'IX0001' }, this.spotRef, this.spot));
    this.live.set(this.futCode, this.mk(
      { security_type: 'FUT', exchange: 'TAIFEX', code: this.futCode }, this.spotRef + 30, this.spot + this.basis));
  }

  private mk(c: Contract, ref: number, last: number, opt?: OptContract): Live {
    const lo = Math.min(ref, last) * 0.995, hi = Math.max(ref, last) * 1.004;
    return { c, ref, last, open: ref, high: hi, low: lo, totalVol: 0, opt };
  }

  private get F() { return this.spot + this.basis; }

  private smileVol(K: number, F: number) {
    const k = Math.log(K / F);
    return Math.max(0.08, 0.17 - 0.9 * k + 6 * k * k);
  }

  private optPrice(o: OptContract) {
    const T = yearsToExpiry(o.delivery_date);
    const p = bsPrice(this.F, o.strike, T, this.smileVol(o.strike, this.F), o.right);
    const tick = p >= 50 ? 1 : p >= 10 ? 0.5 : 0.1;
    return Math.max(0.1, Math.round(p / tick) * tick);
  }

  async info() { return { simulation: true }; }

  async resolve(code: string): Promise<Contract> {
    code = code.toUpperCase();
    if (code === 'TXFR1') return { security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1', target_code: this.futCode };
    if (code.startsWith('IX')) return { security_type: 'IND', exchange: 'TSE', code };
    for (const ch of this.chains.values()) { const o = ch.find((x) => x.code === code); if (o) return o; }
    throw new Error('DEMO 找不到商品 ' + code);
  }

  async contractInfo(c: Contract): Promise<Info> {
    const l = this.get(c);
    const names: Record<string, string> = { IX0001: '發行量加權股價指數', TXFR1: '臺股期貨 近月' };
    const name = names[c.code] ?? l?.opt?.name ?? c.code;
    const ref = l?.ref ?? NaN;
    return { name, reference: ref, limit_up: ref * 1.1, limit_down: ref * 0.9 };
  }

  private norm(code: string) { return code.startsWith('TXF') ? this.futCode : code; }

  private get(c: Contract): Live | undefined {
    return this.live.get(this.norm(c.target_code ?? c.code));
  }

  async snapshots(cs: Contract[]): Promise<Snap[]> {
    return cs.flatMap((c) => {
      const l = this.get(c);
      if (!l) return [];
      return [{
        code: c.code, open: l.open, high: l.high, low: l.low, close: l.last,
        change_price: l.last - l.ref, total_volume: l.totalVol, total_amount: 0,
      }];
    });
  }

  async kbars(c: Contract): Promise<Bar[]> {
    const l = this.get(c);
    if (!l) return [];
    const now = tpeNow();
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
    const start = day + (8 * 60 + 46) * 60;
    const end = Math.min(nowSec() - (nowSec() % 60), day + (13 * 60 + 45) * 60);
    const n = Math.max(30, Math.floor((end - start) / 60) + 1);
    // 從現價倒推一條隨機路徑，終點對齊現價
    const out: Bar[] = [];
    let p = l.last;
    const vol = l.last * (l.opt ? 0.012 : 0.0006);
    for (let i = n - 1; i >= 0; i--) {
      const o = Math.max(0.1, p - (Math.random() - 0.5) * vol * 2);
      const h = Math.max(o, p) + Math.random() * vol;
      const lo = Math.max(0.1, Math.min(o, p) - Math.random() * vol);
      out.unshift({ t: (end > start ? end : start + 299 * 60) - (n - 1 - i) * 60, o, h, l: lo, c: p, v: Math.floor(Math.random() * 400) });
      p = o;
    }
    return out;
  }

  async recentTicks(): Promise<Tick[]> { return []; }
  async scanner(): Promise<ScanRow[]> { return []; }

  async futuresList(): Promise<FutContract[]> {
    const t = tpeNow();
    const mk = (y: number, m: number): FutContract => {
      const d = thirdWed(y, m);
      const code = 'TXF' + MONTH_CODE[d.getUTCMonth()] + String(d.getUTCFullYear()).slice(-1);
      return { security_type: 'FUT', exchange: 'TAIFEX', code, target_code: null, name: '臺股期貨',
        delivery_date: ymd(d), delivery_month: ymd(d).slice(0, 7).replace('-', '') };
    };
    return [mk(t.getUTCFullYear(), t.getUTCMonth()), mk(t.getUTCFullYear(), t.getUTCMonth() + 1)];
  }

  async optionRoots(): Promise<OptRoot[]> {
    return [
      { root: 'TXO', name: '臺指選擇權' },
      { root: 'TX4', name: '臺指選擇權(週三W4)' },
      { root: 'TXU', name: '臺指選擇權(週五F1)' },
      { root: 'CDO', name: '台積電選擇權' },
    ];
  }

  async optionChain(root: string): Promise<OptContract[]> {
    if (this.chains.has(root)) return this.chains.get(root)!;
    const now = tpeNow();
    let exp: Date, step: number;
    if (root === 'TX4') { exp = nextWeekday(now, 3); step = 50; }
    else if (root === 'TXU') { exp = nextWeekday(now, 5); step = 50; }
    else if (root === 'TXO') {
      exp = thirdWed(now.getUTCFullYear(), now.getUTCMonth());
      if (exp.getTime() < now.getTime()) exp = thirdWed(now.getUTCFullYear(), now.getUTCMonth() + 1);
      step = 100;
    } else return [];
    const date = ymd(exp);
    const atm = Math.round(this.F / step) * step;
    const list: OptContract[] = [];
    const yesterdayF = this.spotRef + 30;
    for (let k = atm - 40 * step; k <= atm + 40 * step; k += step) {
      for (const right of ['C', 'P'] as const) {
        const code = `${root}${k}${MONTH_CODE[exp.getUTCMonth() + (right === 'P' ? 12 : 0)] ?? 'X'}${String(exp.getUTCFullYear()).slice(-1)}`;
        const o: OptContract = {
          security_type: 'OPT', exchange: 'TAIFEX', code, target_code: null,
          name: `臺指選擇權 ${date.replace(/-/g, '').slice(0, 6)} ${right} ${k}`,
          root, strike: k, right, delivery_date: date, delivery_month: date.slice(0, 7).replace('-', ''),
          reference: 0,
        };
        const T = yearsToExpiry(date) + 1 / 365;
        o.reference = Math.max(0.1, Math.round(bsPrice(yesterdayF, k, T, this.smileVol(k, yesterdayF), right) * 10) / 10);
        list.push(o);
        const l = this.mk(o, o.reference, this.optPrice(o), o);
        // 成交量：價平附近最大、整數關卡（每 500 點）特別大
        const dist = Math.abs(k - this.F) / (step * 6);
        const round = k % 500 === 0 ? 2.2 : 1;
        l.totalVol = Math.floor(Math.exp(-dist * dist) * 9000 * round * (0.4 + Math.random())
          * (right === 'P' && k < this.F ? 1.25 : 1) + Math.random() * 40);
        l.high = Math.max(l.last, l.ref) * 1.15; l.low = Math.min(l.last, l.ref) * 0.85;
        this.live.set(code, l);
      }
    }
    this.chains.set(root, list);
    return list;
  }

  async subscribe(c: Contract, q: QuoteType) {
    const code = c.target_code ?? c.code;
    if (code.startsWith('TXF')) this.futAlias = code;
    this.subs.add(`${this.norm(code)}:${q}`);
  }
  async unsubscribe(c: Contract, q: QuoteType) {
    const code = c.target_code ?? c.code;
    if (code.startsWith('TXF') && code !== this.futAlias) return; // 換月時舊月份退訂不影響新月份
    this.subs.delete(`${this.norm(code)}:${q}`);
  }

  connect(h: Handlers) {
    this.h = h;
    h.status('demo');
    setInterval(() => this.step(), 400);
  }

  private step() {
    const h = this.h!;
    this.spot += (Math.random() - 0.5) * 6 + (this.spotRef + 150 - this.spot) * 0.001;
    this.basis += (Math.random() - 0.5) * 0.6;
    const t = nowSec();
    const ix = this.live.get('IX0001')!;
    ix.last = this.spot; ix.high = Math.max(ix.high, ix.last); ix.low = Math.min(ix.low, ix.last);
    h.index({
      code: 'IX0001', t, close: ix.last, reference: ix.ref, open: ix.open, high: ix.high, low: ix.low,
      amountSum: 2.85e11, raise: 512, raiseStop: 9, fall: 388, fallStop: 2, flat: 120,
    });
    for (const [code, l] of this.live) {
      if (code === 'IX0001') continue;
      const tickSub = this.subs.has(`${code}:Tick`);
      const baSub = this.subs.has(`${code}:BidAsk`);
      if (!tickSub && !baSub) continue;
      const isFut = code === this.futCode;
      const fair = isFut ? Math.round(this.F) : this.optPrice(l.opt!);
      const trade = isFut || Math.random() < 0.18;
      if (trade && tickSub) {
        const vol = 1 + Math.floor(Math.random() ** 3 * (isFut ? 40 : 120));
        const side = (fair >= l.last ? 1 : 2) as 1 | 2;
        l.last = fair; l.totalVol += vol;
        l.high = Math.max(l.high, fair); l.low = Math.min(l.low, fair);
        h.tick({ code: isFut ? this.futAlias || code : code, t, price: fair, vol, totalVol: l.totalVol, side, high: l.high, low: l.low, open: l.open });
      }
      if (baSub) {
        const tk = isFut ? 1 : fair >= 50 ? 1 : fair >= 10 ? 0.5 : 0.1;
        const bids: [number, number][] = [], asks: [number, number][] = [];
        for (let i = 0; i < 5; i++) {
          bids.push([Math.max(0.1, +(fair - tk * (i + 1)).toFixed(1)), 1 + Math.floor(Math.random() * 60)]);
          asks.push([+(fair + tk * i).toFixed(1), 1 + Math.floor(Math.random() * 60)]);
        }
        h.bidask({ code: isFut ? this.futAlias || code : code, bids, asks });
      }
    }
  }
}
