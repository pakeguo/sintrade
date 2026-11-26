// 權值股與產業類股：官方 index_components 加值串流（只支援 IX0001）
//
// 前 20 大權值股：官方「依權重排行」最多只給前 10 名，所以另外訂閱「貢獻點數」正／負各前 25 名，
// 把串流裡出現過的每檔權重（reference_weight_ppm）記在瀏覽器，取權重前 20。越用越完整。
// 報價：前 20 檔以 Tick 即時訂閱，貢獻點數 = 加權指數參考價 × 權重 × (現價 / 參考價 − 1)。
import { hub } from './hub';
import { fin, LS } from './util';
import type { ComponentsProjection, Contract } from '../types';

export interface Heavy {
  code: string; name: string; weight: number; // 權重（小數，0.416 = 41.6%）
  price: number; ref: number; pct: number; contrib: number;
}
export interface Sector {
  category: string; name: string; weight: number; contrib: number; perf: number;
  amount: number;      // 今日累計成交金額
  flow: number;        // 每秒新增成交金額（平滑後）＝資金流量
  push: number;        // 貢獻點數每秒變化（平滑後）：正＝正在推升指數、負＝正在拖累
}
export interface SectorState { list: Sector[]; live: boolean; asOf: string }

const P_WEIGHT: ComponentsProjection = { kind: 'ranking', target: 'component', metric: 'weight', order: 'desc', limit: 10 };
const P_POS: ComponentsProjection = { kind: 'ranking', target: 'component', metric: 'contribution', order: 'positive_desc', limit: 25 };
const P_NEG: ComponentsProjection = { kind: 'ranking', target: 'component', metric: 'contribution', order: 'negative_asc', limit: 25 };
const G_CONTRIB: ComponentsProjection = { kind: 'group_metric', metric: 'contribution' };
const G_WEIGHT: ComponentsProjection = { kind: 'group_metric', metric: 'weight' };
const G_PERF: ComponentsProjection = { kind: 'group_metric', metric: 'weighted_performance' };
const G_AMOUNT: ComponentsProjection = { kind: 'group_metric', metric: 'amount' };
const ALL = [P_WEIGHT, P_POS, P_NEG, G_CONTRIB, G_WEIGHT, G_PERF, G_AMOUNT];

// 第一次使用、權重尚未收集到之前的預設清單（只用代碼排序，權重以串流為準）
const SEED = ['2330', '2317', '2454', '2308', '2382', '2881', '2891', '3711', '2882', '2412',
  '2303', '2886', '2884', '2345', '3017', '2357', '6669', '1216', '2885', '3231'];

class Components {
  private users = new Set<string>();
  private weights = LS.getJSON<Record<string, number>>('weights', {}); // code → ppm
  private names = LS.getJSON<Record<string, string>>('names', {});
  private refs = new Map<string, number>();
  private sectors = new Map<string, Sector>();
  private sectorsAsOf = '';
  private sectorsLiveAt = 0;   // 最後一次收到即時類股資料的時間（毫秒）
  private lastSectorSave = 0;
  private top: string[] = [];
  private off: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** 頁面開始使用（引用計數；最後一個使用者離開才退訂） */
  use(owner: string) {
    this.users.add(owner);
    if (this.users.size > 1) return;
    this.off = hub.on('components', (u) => this.onUpdate(u));
    for (const p of ALL) {
      hub.be.subscribeComponents(p).catch((e) => {
        console.warn('components subscribe', p, e);
        this.diag.errors.push(`${p.kind}/${p.metric}: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      });
    }
    this.refreshTop();
  }
  unuse(owner: string) {
    if (!this.users.delete(owner) || this.users.size) return;
    this.off?.(); this.off = null;
    for (const p of ALL) hub.be.unsubscribeComponents(p).catch(() => undefined);
    hub.releaseAll('components');
  }

  /** 診斷用：各串流收到幾筆、試撮筆數、訂閱錯誤、最後收到時間 */
  readonly diag = { recv: {} as Record<string, number>, simtrade: 0, errors: [] as string[], lastAt: 0, logged: new Set<string>() };

  private onUpdate(u: import('../types').ComponentsUpdate) {
    const p = (u.projection ?? {}) as ComponentsProjection;
    const key = `${p.kind ?? '?'}/${p.metric ?? '?'}`;
    if (!this.diag.logged.has(key)) {
      this.diag.logged.add(key);
      console.info('[類股串流] 第一筆', key, JSON.parse(JSON.stringify(u)));
    }
    if (u.simtrade) { this.diag.simtrade++; return; }
    this.diag.recv[key] = (this.diag.recv[key] ?? 0) + 1;
    this.diag.lastAt = Date.now();
    if (u.entries) {
      let changed = false;
      for (const e of u.entries) {
        if (fin(e.weightPpm) && e.weightPpm > 0 && this.weights[e.code] !== e.weightPpm) { this.weights[e.code] = e.weightPpm; changed = true; }
        if (fin(e.reference) && e.reference > 0) this.refs.set(e.code, e.reference);
        const x = hub.q(e.code);
        if (!fin(x.ref) && fin(e.reference)) x.ref = e.reference;
        if (!fin(x.last) && fin(e.price)) x.last = e.price;
      }
      if (changed) { this.refreshTop(); this.save(); }
    }
    // 有 groups 就當作類股資料（不依賴 projection.kind 的確切寫法）
    if (u.groups && p.kind !== 'ranking') {
      const now = performance.now();
      for (const g of u.groups) {
        let s = this.sectors.get(g.category) as (Sector & { _at?: number; _c?: number; _a?: number }) | undefined;
        if (!s) {
          s = { category: g.category, name: g.name, weight: NaN, contrib: NaN, perf: NaN, amount: NaN, flow: 0, push: 0 };
          this.sectors.set(g.category, s);
        }
        s.name = g.name;
        if (p.metric === 'contribution') {
          // 貢獻點數的變化速度（指數平滑），代表這個類股「此刻」正在推升或拖累大盤
          if (fin(s.contrib) && s._c !== undefined) {
            const dt = Math.max(0.2, (now - (s._at ?? now)) / 1000);
            s.push = s.push * 0.6 + ((g.value - s.contrib) / dt) * 0.4;
          }
          s.contrib = g.value; s._c = 1; s._at = now;
        }
        if (p.metric === 'weight') s.weight = g.value;
        if (p.metric === 'weighted_performance') s.perf = g.value;
        if (p.metric === 'amount') {
          if (fin(s.amount) && s._a !== undefined && g.value >= s.amount) {
            const dt = Math.max(0.2, (now - s._a) / 1000);
            s.flow = s.flow * 0.6 + ((g.value - s.amount) / dt) * 0.4;
          }
          s.amount = g.value; s._a = now;
        }
      }
      this.sectorsLiveAt = Date.now();
      if (u.date || u.time) this.sectorsAsOf = `${u.date ?? ''} ${u.time ?? ''}`.trim();
      // 每 10 秒存一份到瀏覽器，盤後串流不再推送時用來顯示收盤值
      if (Date.now() - this.lastSectorSave > 10_000) {
        this.lastSectorSave = Date.now();
        const list = this.sectorList().map((x) => ({ ...x, flow: 0, push: 0 }));
        if (list.length) LS.setJSON('sectorsClose', { asOf: this.sectorsAsOf || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' '), list });
      }
    }
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { LS.setJSON('weights', this.weights); LS.setJSON('names', this.names); }, 2000);
  }

  /** 依權重重新挑前 20 檔並調整即時訂閱 */
  private refreshTop() {
    const known = Object.entries(this.weights).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const next = [...new Set([...known, ...SEED])].slice(0, 20);
    const stk = (code: string): Contract => ({ security_type: 'STK', exchange: 'TSE', code });
    for (const c of this.top) if (!next.includes(c)) hub.release('components', stk(c), ['Tick']);
    const added = next.filter((c) => !this.top.includes(c));
    this.top = next;
    if (!added.length) return;
    for (const c of added) hub.acquire('components', stk(c), ['Tick']);
    hub.loadSnapshots(added.map(stk));
    for (const c of added) {
      if (this.names[c]) continue;
      hub.be.contractInfo(stk(c)).then((i) => { this.names[c] = i.name; this.save(); }).catch(() => undefined);
    }
  }

  heavies(n = 20): Heavy[] {
    const ixRef = hub.idx?.reference ?? NaN;
    return this.top.slice(0, n).map((code) => {
      const x = hub.quotes.get(code);
      const price = x?.last ?? NaN;
      const ref = fin(x?.ref ?? NaN) ? x!.ref : this.refs.get(code) ?? NaN;
      const w = (this.weights[code] ?? NaN) / 1e6;
      const pct = (price / ref - 1) * 100;
      return { code, name: this.names[code] ?? code, weight: w, price, ref, pct, contrib: ixRef * w * (price / ref - 1) };
    });
  }

  sectorList(): Sector[] {
    return [...this.sectors.values()].filter((s) => fin(s.weight) && s.weight > 0).sort((a, b) => b.weight - a.weight);
  }

  /** 熱力圖用：有即時資料就用即時（live）；沒有（盤後串流不推送）就用最後存下的收盤值 */
  sectorState(): SectorState {
    const list = this.sectorList();
    if (list.length) return { list, live: Date.now() - this.sectorsLiveAt < 15_000, asOf: this.sectorsAsOf };
    const cached = LS.getJSON<{ asOf: string; list: Sector[] } | null>('sectorsClose', null);
    if (cached?.list?.length) return { list: cached.list, live: false, asOf: cached.asOf };
    return { list: [], live: false, asOf: '' };
  }
}

export const components = new Components();
