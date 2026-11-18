// 使用者設定（自選股群組、大單門檻…）
// 經由 phone-server（http://localhost:5180 或手機）開啟時存在電腦上的 mywatch-store.json → 電腦手機同步；
// 從 shioaji server（/apps/mywatch/）開啟時沒有這個端點 → 退回瀏覽器 localStorage。
import { LS } from './util';

export interface WatchGroup { id: string; name: string; codes: string[] }
export interface StoreData {
  groups: WatchGroup[];
  bigTiers: [number, number, number]; // 大單門檻（元）：中實戶、大戶、法人級
}

const DEFAULTS: StoreData = {
  groups: [{ id: 'g1', name: '自選', codes: ['2330', '2317', '2454'] }],
  bigTiers: [1_000_000, 5_000_000, 20_000_000],
};

class Store {
  data: StoreData = { ...DEFAULTS, ...LS.getJSON<Partial<StoreData>>('store', {}) };
  synced = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  async load() {
    try {
      const r = await fetch('/mw/store', { cache: 'no-store' });
      if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
        const d = await r.json() as Partial<StoreData>;
        this.synced = true;
        if (d.groups?.length) this.data = { ...DEFAULTS, ...d };
        else this.save(); // 伺服器上還沒有：把目前（瀏覽器）的設定上傳
      }
    } catch { /* 不支援同步，用 localStorage */ }
    this.emit();
  }

  save() {
    LS.setJSON('store', this.data);
    if (!this.synced) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      fetch('/mw/store', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.data) })
        .catch(() => undefined);
    }, 500);
  }

  update(fn: (d: StoreData) => void) { fn(this.data); this.save(); this.emit(); }
  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f()); }
}

export const store = new Store();
