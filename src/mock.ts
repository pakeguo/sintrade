// DEMO 後端：不連 shioaji server，用隨機漫步 + Black-76 產生擬真的期權行情。
// 只用於預覽介面（網址加 ?demo=1，或連不到 server 時自動切換）。
import { price as bsPrice, yearsToExpiry } from './bs';
import type {
  Account, ComponentEntry, ComponentsProjection, GroupEntry,
  Backend, Bar, Contract, FutContract, Handlers, Info, OptContract, OptRoot, QuoteType, ScanRow, Snap, Tick,
} from './types';

const tpeNow = () => new Date(Date.now() + 8 * 3600_000); // 用 UTC getter 讀台北時間
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const nowSec = () => Math.floor(tpeNow().getTime() / 1000);

interface Live {
  c: Contract; ref: number; last: number; open: number; high: number; low: number;
  totalVol: number; opt?: OptContract;
  off?: number; // 期貨：相對台指期近月的價差（次月、遠月）
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

// DEMO 權值股：代碼、名稱、產業代碼、權重（ppm）、參考價
const STOCKS: [string, string, string, number, number][] = [
  ['2330', '台積電', '24', 416000, 1450], ['2317', '鴻海', '31', 52000, 220], ['2454', '聯發科', '24', 41000, 1400],
  ['2308', '台達電', '28', 28000, 680], ['2382', '廣達', '25', 17000, 290], ['2881', '富邦金', '17', 16000, 92],
  ['2891', '中信金', '17', 15000, 45], ['3711', '日月光投控', '24', 14000, 230], ['2882', '國泰金', '17', 13000, 66],
  ['2412', '中華電', '27', 12000, 128], ['2303', '聯電', '24', 10000, 48], ['2886', '兆豐金', '17', 9500, 41],
  ['2884', '玉山金', '17', 9000, 30], ['2345', '智邦', '27', 8800, 980], ['3017', '奇鋐', '25', 8500, 1100],
  ['2357', '華碩', '25', 8000, 620], ['6669', '緯穎', '25', 7800, 2900], ['1216', '統一', '18', 7500, 78],
  ['2885', '元大金', '17', 7200, 34], ['3231', '緯創', '25', 7000, 120], ['2892', '第一金', '17', 6500, 28],
  ['2603', '長榮', '15', 6200, 210], ['2002', '中鋼', '20', 5000, 21], ['1301', '台塑', '3', 4500, 40],
];
// DEMO 其他股票（搜尋與類股瀏覽用）：代碼、名稱、產業
const EXTRA: [string, string, string][] = [
  ['2603', '長榮', '15'], ['2609', '陽明', '15'], ['2615', '萬海', '15'], ['2002', '中鋼', '20'], ['1301', '台塑', '3'],
  ['1303', '南亞', '3'], ['1101', '台泥', '1'], ['2912', '統一超', '18'], ['3008', '大立光', '26'], ['2409', '友達', '26'],
  ['3481', '群創', '26'], ['2337', '旺宏', '24'], ['2408', '南亞科', '24'], ['3034', '聯詠', '24'], ['2379', '瑞昱', '24'],
  ['1802', '台玻', '8'], ['0050', '元大台灣50', '00'], ['0056', '元大高股息', '00'], ['00878', '國泰永續高股息', '00'],
  ['00919', '群益台灣精選高息', '00'], ['2618', '長榮航', '15'], ['2610', '華航', '15'], ['4904', '遠傳', '27'], ['3045', '台灣大', '27'],
];
const GROUPS: [string, string][] = [
  ['24', '半導體業'], ['28', '電子零組件業'], ['25', '電腦及週邊設備業'], ['17', '金融保險'], ['31', '其他電子業'],
  ['27', '通信網路業'], ['26', '光電業'], ['15', '航運業'], ['3', '塑膠工業'], ['20', '鋼鐵工業'], ['18', '貿易百貨'], ['5', '電機機械'],
];

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
    if (code.startsWith('IX')) return { security_type: 'IND', exchange: code === 'IX0043' ? 'OTC' : 'TSE', code };
    if (/^\d{4,6}[A-Z]?$/.test(code)) return { security_type: 'STK', exchange: 'TSE', code };
    const fm = code.match(/^(TXF|MXF|TMF)[A-L]\d$/);
    if (fm) return (await this.futuresList(fm[1])).find((f) => f.code === code) ?? { security_type: 'FUT', exchange: 'TAIFEX', code };
    if (!this.chains.size) for (const r of ['TXO', 'TX4', 'TXU']) await this.optionChain(r);
    for (const ch of this.chains.values()) { const o = ch.find((x) => x.code === code); if (o) return o; }
    throw new Error('DEMO 找不到商品 ' + code);
  }

  async contractInfo(c: Contract): Promise<Info> {
    const l = this.get(c);
    const names: Record<string, string> = { IX0001: '發行量加權股價指數', TXFR1: '臺股期貨 近月' };
    for (const [code, name] of STOCKS) names[code] = name;
    const name = names[c.code] ?? l?.opt?.name ?? c.code;
    const ref = l?.ref ?? NaN;
    const extra = EXTRA.find((x) => x[0] === c.code);
    const cat = STOCKS.find((x) => x[0] === c.code)?.[2] ?? extra?.[2];
    return { name: extra?.[1] ?? name, reference: ref, limit_up: ref * 1.1, limit_down: ref * 0.9, category: cat };
  }

  async stockList(): Promise<Contract[]> {
    return [...STOCKS.map((s) => s[0]), ...EXTRA.map((s) => s[0])].map((code) => ({ security_type: 'STK', exchange: 'TSE', code }));
  }

  private norm(code: string) { return code.startsWith('TXF') ? this.futCode : code; }

  private get(c: Contract): Live | undefined {
    let code = this.norm(c.target_code ?? c.code);
    const r1 = code.match(/^(MXF|TMF)R1$/);
    if (r1) code = r1[1] + this.futCode.slice(3); // 小台／微台連續月 → 近月
    let l = this.live.get(code);
    const fm = code.match(/^(MXF|TMF)([A-L])\d$/);
    if (!l && fm) {
      // 小台／微台：以台指期近月為基準，越遠的月份加一點價差
      const near = MONTH_CODE.indexOf(this.futCode[3]);
      const k = (MONTH_CODE.indexOf(fm[2]) - near + 12) % 12;
      const off = k * 18 - 6;
      l = this.mk({ security_type: 'FUT', exchange: 'TAIFEX', code }, this.spotRef + 30 + off, Math.round(this.F + off));
      l.off = off;
      l.totalVol = Math.floor(20000 / (k + 1) + Math.random() * 3000);
      this.live.set(code, l);
    }
    if (!l && /^\d{4,6}[A-Z]?$/.test(code)) {
      // 個股：權值股用固定參考價，其他代碼用代碼算一個假的價位
      const s = STOCKS.find((x) => x[0] === code);
      const ref = s ? s[4] : 20 + (Number(code.slice(0, 4)) % 480);
      const last = this.stockPx.get(code) ?? +(ref * (1 + (Math.random() - 0.45) * 0.03)).toFixed(ref > 100 ? 0 : 2);
      this.stockPx.set(code, last);
      l = this.mk({ security_type: 'STK', exchange: 'TSE', code }, ref, last);
      l.totalVol = Math.floor(Math.random() * 30000) + 2000;
      this.live.set(code, l);
    }
    return l;
  }

  async snapshots(cs: Contract[]): Promise<Snap[]> {
    return cs.flatMap((c) => {
      const l = this.get(c);
      if (!l) return [];
      return [{
        code: c.code, open: l.open, high: l.high, low: l.low, close: l.last,
        change_price: l.last - l.ref, total_volume: l.totalVol, total_amount: 0, buy_price: NaN, sell_price: NaN,
        yesterday_volume: Math.round(l.totalVol * (0.7 + Math.random() * 0.8)), volume_ratio: +(0.6 + Math.random() * 1.2).toFixed(2),
      }];
    });
  }

  async kbars(c: Contract, from?: string, to?: string): Promise<Bar[]> {
    const l = this.get(c);
    if (!l) return [];
    if ((l.c.security_type === 'STK' || l.c.security_type === 'IND') && from && to) return this.stockBars(l, from, to);
    if ((l.c.security_type === 'FUT' || l.c.security_type === 'OPT') && from && to) return this.futBars(l, from, to);
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

  /** 確定性的價格路徑（同一時間點每次都一樣，分批往前抓時才接得起來）：回傳相對現在的對數變化 */
  private wave(code: string, t: number, amp: number) {
    const s = [...code].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
    const x = t / 86400;
    const n = Math.sin(t * 12.9898 + s) * 43758.5453;
    return amp * (0.10 * Math.sin(x / 53 + s) + 0.05 * Math.sin(x / 11.7 + s * 2) + 0.02 * Math.sin(x * 2.3 + s)
      + 0.006 * Math.sin(t / 1900 + s) + 0.003 * Math.sin(t / 310 + s * 3) + 0.0008 * (n - Math.floor(n) - 0.5));
  }
  private pathBars(l: Live, times: number[], amp: number, rd: (x: number) => number, vmax: number): Bar[] {
    const now = nowSec(), base = this.wave(l.c.code, now, amp);
    const px = (t: number) => l.last * Math.exp(this.wave(l.c.code, t, amp) - base);
    return times.map((t) => {
      const o = px(t - 60), c = px(t), j = Math.abs(o - c) * 0.6 + c * 0.0004 * amp;
      return { t, o: rd(o), h: rd(Math.max(o, c) + j * ((t * 7) % 10) / 10), l: rd(Math.min(o, c) - j * ((t * 3) % 10) / 10), c: rd(c),
        v: Math.floor(((Math.sin(t * 1.7) + 1) / 2) ** 2 * vmax) + 5 };
    });
  }

  /** 期貨／選擇權多日 1 分 K：平日日盤 08:46–13:45＋夜盤 15:01–隔日 05:00 */
  private futBars(l: Live, start: string, end: string): Bar[] {
    const nowS = nowSec();
    const times: number[] = [];
    for (let d = Date.parse(start + 'T00:00:00Z') / 1000; d <= Date.parse(end + 'T00:00:00Z') / 1000; d += 86400) {
      const wd = new Date(d * 1000).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      for (let m = 8 * 60 + 46; m <= 13 * 60 + 45; m++) times.push(d + m * 60);
      for (let m = 15 * 60 + 1; m <= 24 * 60; m++) times.push(d + m * 60);
      if (wd !== 1) for (let m = 1; m <= 5 * 60; m++) times.push(d + m * 60); // 前一晚夜盤延續到 05:00
    }
    const ts = times.filter((x) => x <= nowS).sort((a, b) => a - b);
    // 選擇權：價格小、波動大，四捨五入到 0.1 並不低於 0.1
    return l.opt ? this.pathBars(l, ts, 6, (x) => Math.max(0.1, Math.round(x * 10) / 10), 300)
      : this.pathBars(l, ts, 1, Math.round, 900);
  }

  /** 個股多日 1 分 K：每個平日 09:01–13:30 */
  private stockBars(l: Live, start: string, end: string): Bar[] {
    const nowS = nowSec();
    const ts: number[] = [];
    for (let d = Date.parse(start + 'T00:00:00Z') / 1000; d <= Date.parse(end + 'T00:00:00Z') / 1000; d += 86400) {
      const wd = new Date(d * 1000).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      for (let m = 1; m <= 270; m++) { const t = d + 9 * 3600 + m * 60; if (t <= nowS) ts.push(t); }
    }
    const tick = (x: number) => +x.toFixed(l.ref > 100 ? 0 : 2);
    return this.pathBars(l, ts, 2, tick, 900);
  }

  async ticksDay(c: Contract): Promise<Tick[]> {
    const l = this.get(c);
    if (!l) return [];
    const now = tpeNow();
    const d0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
    const deriv = l.c.security_type === 'FUT' || l.c.security_type === 'OPT';
    // 期貨／選擇權：從現在往回產生（不限日盤時段，畫面會依時間軸過濾）
    const endT = deriv ? nowSec() : Math.min(nowSec(), d0 + 13 * 3600 + 30 * 60);
    const startT = deriv ? endT - 20 * 3600 : d0 + 9 * 3600;
    const out: Tick[] = [];
    let p = l.last;
    for (let t = endT; t > startT && out.length < 1500; t -= 2 + Math.floor(Math.random() * (deriv ? 40 : 20))) {
      const big = Math.random() < 0.02;
      const vol = big ? 20 + Math.floor(Math.random() * 400) : 1 + Math.floor(Math.random() ** 3 * 30);
      out.unshift({ code: l.c.code, t, price: p, vol, totalVol: NaN, side: Math.random() > 0.48 ? 1 : 2 });
      p = +(p * (1 + (Math.random() - 0.5) * 0.002)).toFixed(l.ref > 100 ? 0 : 2);
    }
    return out;
  }

  async recentTicks(): Promise<Tick[]> { return []; }
  async scanner(type: string, _asc: boolean, count: number): Promise<ScanRow[]> {
    const all = [...STOCKS.map((s) => [s[0], s[1], s[4]] as const), ...EXTRA.map((s) => [s[0], s[1], 20 + (Number(s[0]) % 300)] as const)];
    const rows = all.map(([code, name, ref], i) => {
      const close = this.stockPx.get(code) ?? ref * (1 + Math.sin(i * 7.3) * 0.03);
      const volume = Math.round(3000 + Math.abs(Math.sin(i * 3.1)) * 80000);
      return { code, name, close, chg: close - ref, pct: (close / ref - 1) * 100, volume, amount: volume * close * 1000 };
    });
    rows.sort((a, b) => (type === 'AmountRank' ? b.amount - a.amount : b.volume - a.volume));
    return rows.slice(0, count);
  }

  async futuresList(root = 'TXF'): Promise<FutContract[]> {
    const t = tpeNow();
    const names: Record<string, string> = { TXF: '臺股期貨', MXF: '小型臺指', TMF: '微型臺指' };
    const mk = (y: number, m: number): FutContract => {
      const d = thirdWed(y, m);
      const code = root + MONTH_CODE[d.getUTCMonth()] + String(d.getUTCFullYear()).slice(-1);
      return { security_type: 'FUT', exchange: 'TAIFEX', code, target_code: null, name: `${names[root] ?? root} ${ymd(d).slice(0, 7).replace('-', '')}`,
        delivery_date: ymd(d), delivery_month: ymd(d).slice(0, 7).replace('-', '') };
    };
    return [mk(t.getUTCFullYear(), t.getUTCMonth()), mk(t.getUTCFullYear(), t.getUTCMonth() + 1), mk(t.getUTCFullYear(), t.getUTCMonth() + 2)];
  }

  // ── 帳務（假資料） ──
  async accounts(): Promise<Account[]> {
    return [
      { account_type: 'F', broker_id: 'F002000', account_id: '0000001', signed: true },
      { account_type: 'S', broker_id: '9A9B', account_id: '0000002', signed: true },
    ];
  }
  async portfolio<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const type = body.account_type;
    const F = this.F;
    if (path === 'margin') {
      const fpnl = (F - 27700) * 200 * 2;
      return { equity: 1_250_000 + fpnl, equity_amount: 1_250_000 + fpnl, available_margin: 820_000 + fpnl,
        initial_margin: 430_000, maintenance_margin: 330_000, risk_indicator: (1_250_000 + fpnl) / 330_000 * 100,
        future_open_position: fpnl, option_open_position: 12_500, today_balance: 1_250_000, yesterday_balance: 1_230_000 } as T;
    }
    if (path === 'position_unit' && type === 'F') {
      // &nopos=1：模擬沒有期權部位（使用者實際狀況，pitfalls #17）
      if (new URLSearchParams(location.search).has('nopos')) return [] as T;
      return [
        { id: 0, code: this.futAlias || this.futCode, direction: 'Buy', quantity: 2, price: 27700, last_price: F, pnl: (F - 27700) * 200 * 2 },
        { id: 2, code: 'TXO202612' + '27500P', direction: 'Buy', quantity: 3, price: 120, last_price: 95, pnl: -25 * 50 * 3 },
        { id: 1, code: 'TXO202612' + '28000C', direction: 'Sell', quantity: 5, price: 180, last_price: 155, pnl: 25 * 50 * 5 },
      ] as T;
    }
    if (path === 'position_unit' && type === 'S') {
      const tsmc = this.stockPx.get('2330') ?? 1450;
      return [
        { id: 0, code: '2330', direction: 'Buy', quantity: 2, price: 1380, last_price: tsmc, pnl: (tsmc - 1380) * 2000 },
        { id: 1, code: '2884', direction: 'Buy', quantity: 10, price: 31.5, last_price: 30.2, pnl: (30.2 - 31.5) * 10000, yd_quantity: 6 },
      ] as T;
    }
    if (path === 'profit_loss') {
      // 期間內每個交易日產生幾筆假的已實現損益（以日期為種子，重新整理數字不變）
      const out: Record<string, unknown>[] = [];
      const b = new Date(String(body.begin_date) + 'T00:00:00Z'), e = new Date(String(body.end_date) + 'T00:00:00Z');
      for (let d = b; d <= e; d = new Date(d.getTime() + 86400_000)) {
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        const seed = (d.getUTCDate() * 37 + d.getUTCMonth() * 11 + (type === 'F' ? 3 : 7)) % 23;
        if (seed % 3 === 0) continue;
        const date = d.toISOString().slice(0, 10);
        out.push(type === 'F'
          ? { id: out.length, code: seed % 2 ? 'TXFL6' : 'TXO202612' + (27600 + seed * 50) + 'C', quantity: 1 + (seed % 3), pnl: (seed - 11) * 1_900, date, direction: 'Buy' }
          : { id: out.length, code: ['2603', '2884', '2317'][seed % 3], quantity: 1, pnl: (seed - 10) * 820, date, direction: 'Buy' });
      }
      return out as T;
    }
    if (path === 'settlements') {
      const t = tpeNow().toISOString().slice(0, 10);
      return [{ date: t, amount: -1_380_000, T: 0 }, { date: t, amount: 62_400, T: 1 }, { date: t, amount: 0, T: 2 }] as T;
    }
    return [] as T;
  }

  // ── 權值股／類股加值串流（假資料） ──
  private stockPx = new Map<string, number>();
  private compSubs = new Map<string, ComponentsProjection>();
  async subscribeComponents(p: ComponentsProjection) { this.compSubs.set(JSON.stringify(p), p); }
  async unsubscribeComponents(p: ComponentsProjection) { this.compSubs.delete(JSON.stringify(p)); }
  private groupAmt = new Map<string, number>();
  private closeSent = new Set<string>();
  private emitComponents() {
    const h = this.h!;
    // 只在日盤（09:00–13:30）持續推送；盤後最多送一次最後的數值（&quiet=1 則完全不送，用來測收盤快取）
    const tw = tpeNow(), mins = tw.getUTCHours() * 60 + tw.getUTCMinutes(), wd = tw.getUTCDay();
    const open = wd >= 1 && wd <= 5 && mins >= 9 * 60 && mins < 13 * 60 + 30;
    const quiet = new URLSearchParams(location.search).has('quiet');
    const timeStr = open ? tw.toISOString().slice(11, 19) : '13:30:00';
    const dateStr = tw.toISOString().slice(0, 10);
    const drift = (this.spot - this.spotRef) / this.spotRef;
    const entries: ComponentEntry[] = STOCKS.map(([code, , cat, w, ref]) => {
      const prev = this.stockPx.get(code) ?? ref * (1 + drift * (0.6 + Math.random()));
      const price = +(prev * (1 + (Math.random() - 0.5) * 0.002)).toFixed(ref > 100 ? 0 : 2);
      this.stockPx.set(code, price);
      const pct = (price / ref - 1) * 100;
      return { code, category: cat, price, reference: ref, pct, weightPpm: w, value: this.spotRef * (w / 1e6) * (price / ref - 1) };
    });
    for (const p of this.compSubs.values()) {
      const key = JSON.stringify(p);
      // 實盤收不到 group_metric/weight（pitfalls #13），&noweight=1 模擬這個情況
      if (p.kind === 'group_metric' && p.metric === 'weight' && new URLSearchParams(location.search).has('noweight')) continue;
      if (!open) {
        if (quiet || this.closeSent.has(key)) continue;
        this.closeSent.add(key);
      }
      if (p.kind === 'ranking') {
        let list = [...entries];
        if (p.metric === 'weight') list.sort((a, b) => b.weightPpm - a.weightPpm);
        else if (p.order === 'positive_desc') list = list.filter((e) => e.value > 0).sort((a, b) => b.value - a.value);
        else if (p.order === 'negative_asc') list = list.filter((e) => e.value < 0).sort((a, b) => a.value - b.value);
        else list.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
        h.components({ projection: p, entries: list.slice(0, p.limit).map((e) => ({ ...e, value: p.metric === 'weight' ? e.weightPpm / 1e4 : e.value })) });
      } else {
        const groups: GroupEntry[] = GROUPS.map(([cat, name]) => {
          const es = entries.filter((e) => e.category === cat);
          const w = es.reduce((s, e) => s + e.weightPpm, 0) / 1e4 + 1.5;
          const contrib = es.reduce((s, e) => s + e.value, 0) + (Math.random() - 0.5) * 2;
          const perf = w ? (contrib / this.spotRef) / (w / 100) * 100 : 0;
          let amt = this.groupAmt.get(cat) ?? w * 8e8 * (0.6 + Math.random());
          if (open && p.metric === 'amount') amt += w * 4e6 * (0.3 + Math.random() * 1.7) * (1 + Math.abs(perf));
          this.groupAmt.set(cat, amt);
          const value = p.metric === 'weight' ? w : p.metric === 'contribution' ? contrib : p.metric === 'amount' ? amt : perf;
          return { category: cat, name, count: Math.max(es.length * 6, 7), value };
        });
        h.components({ projection: p, groups, date: dateStr, time: timeStr });
      }
    }
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
    setInterval(() => this.emitComponents(), 1000);
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
      amountSum: 2.85e11, prevAmountSum: 3.1e11, raise: 512, raiseStop: 9, fall: 388, fallStop: 2, flat: 120,
    });
    const otc = 262 + (this.spot - this.spotRef) / 120;
    h.index({
      code: 'IX0043', t, close: otc, reference: 261, open: 261, high: otc + 0.6, low: 260.2,
      amountSum: 9.2e10, prevAmountSum: 8.8e10, raise: 420, raiseStop: 6, fall: 330, fallStop: 1, flat: 95,
    });
    for (const [code, l] of this.live) {
      if (code === 'IX0001') continue;
      const tickSub = this.subs.has(`${code}:Tick`);
      const baSub = this.subs.has(`${code}:BidAsk`);
      if (!tickSub && !baSub) continue;
      const isTx = code === this.futCode;
      const isFut = isTx || l.c.security_type === 'FUT';
      const isStk = l.c.security_type === 'STK';
      let fair: number;
      if (isStk) {
        const tk = l.ref > 1000 ? 5 : l.ref > 100 ? 0.5 : 0.05;
        const base = this.stockPx.get(code) ?? l.last;
        fair = +(Math.round((base + (Math.random() - 0.5) * tk * 2) / tk) * tk).toFixed(2);
        this.stockPx.set(code, fair);
      } else fair = isFut ? Math.round(this.F + (l.off ?? 0)) : this.optPrice(l.opt!);
      const trade = isFut || Math.random() < (isStk ? 0.5 : 0.18);
      if (trade && tickSub) {
        const vol = isStk && Math.random() < 0.03 ? 50 + Math.floor(Math.random() * 600)
          : 1 + Math.floor(Math.random() ** 3 * (isFut ? 40 : isStk ? 25 : 120));
        const side = (fair >= l.last ? 1 : 2) as 1 | 2;
        l.last = fair; l.totalVol += vol;
        l.high = Math.max(l.high, fair); l.low = Math.min(l.low, fair);
        h.tick({ code: isTx ? this.futAlias || code : code, t, price: fair, vol, totalVol: l.totalVol, side, high: l.high, low: l.low, open: l.open });
      }
      if (baSub) {
        const tk = isStk ? (l.ref > 1000 ? 5 : l.ref > 100 ? 0.5 : 0.05) : isFut ? 1 : fair >= 50 ? 1 : fair >= 10 ? 0.5 : 0.1;
        const bids: [number, number][] = [], asks: [number, number][] = [];
        for (let i = 0; i < 5; i++) {
          bids.push([Math.max(0.01, +(fair - tk * (i + 1)).toFixed(2)), 1 + Math.floor(Math.random() * 60)]);
          asks.push([+(fair + tk * i).toFixed(2), 1 + Math.floor(Math.random() * 60)]);
        }
        h.bidask({ code: isTx ? this.futAlias || code : code, bids, asks });
      }
    }
  }
}
