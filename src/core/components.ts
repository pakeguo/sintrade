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
export interface Sector { category: string; name: string; weight: number; contrib: number; perf: number }

const P_WEIGHT: ComponentsProjection = { kind: 'ranking', target: 'component', metric: 'weight', order: 'desc', limit: 10 };
const P_POS: ComponentsProjection = { kind: 'ranking', target: 'component', metric: 'contribution', order: 'positive_desc', limit: 25 };
const P_NEG: ComponentsProjection = { kind: 'ranking', target: 'component', metric: 'contribution', order: 'negative_asc', limit: 25 };
const G_CONTRIB: ComponentsProjection = { kind: 'group_metric', metric: 'contribution' };
const G_WEIGHT: ComponentsProjection = { kind: 'group_metric', metric: 'weight' };
const G_PERF: ComponentsProjection = { kind: 'group_metric', metric: 'weighted_performance' };
const ALL = [P_WEIGHT, P_POS, P_NEG, G_CONTRIB, G_WEIGHT, G_PERF];

// 第一次使用、權重尚未收集到之前的預設清單（只用代碼排序，權重以串流為準）
const SEED = ['2330', '2317', '2454', '2308', '2382', '2881', '2891', '3711', '2882', '2412',
  '2303', '2886', '2884', '2345', '3017', '2357', '6669', '1216', '2885', '3231'];

class Components {
  private users = new Set<string>();
  private weights = LS.getJSON<Record<string, number>>('weights', {}); // code → ppm
  private names = LS.getJSON<Record<string, string>>('names', {});
  private refs = new Map<string, number>();
  private sectors = new Map<string, Sector>();
  private top: string[] = [];
  private off: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** 頁面開始使用（引用計數；最後一個使用者離開才退訂） */
  use(owner: string) {
    this.users.add(owner);
    if (this.users.size > 1) return;
    this.off = hub.on('components', (u) => this.onUpdate(u));
    for (const p of ALL) hub.be.subscribeComponents(p).catch((e) => console.warn('components', e));
    this.refreshTop();
  }
  unuse(owner: string) {
    if (!this.users.delete(owner) || this.users.size) return;
    this.off?.(); this.off = null;
    for (const p of ALL) hub.be.unsubscribeComponents(p).catch(() => undefined);
    hub.releaseAll('components');
  }

  private onUpdate(u: import('../types').ComponentsUpdate) {
    const p = u.projection;
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
    if (u.groups && p.kind === 'group_metric') {
      for (const g of u.groups) {
        const s = this.sectors.get(g.category) ?? { category: g.category, name: g.name, weight: NaN, contrib: NaN, perf: NaN };
        s.name = g.name;
        if (p.metric === 'contribution') s.contrib = g.value;
        if (p.metric === 'weight') s.weight = g.value;
        if (p.metric === 'weighted_performance') s.perf = g.value;
        this.sectors.set(g.category, s);
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
}

export const components = new Components();
