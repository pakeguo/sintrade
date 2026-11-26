// 股票目錄：代碼 → 名稱、產業、交易所（名稱搜尋、類股瀏覽用）
//
// shioaji 的合約清單只有代碼；名稱與產業要逐檔查 /data/contracts/{code}/info（查 server 本機商品檔，很快）。
// 第一次在背景建立（約 1–2 分鐘，有進度），存在 localStorage，7 天後重新補齊。
import { hub } from './hub';
import { LS } from './util';
import type { Contract } from '../types';

export interface StockEntry { code: string; name: string; cat: string; ex: string }

/** 證交所／櫃買產業別代碼（券商 App 的類股分類） */
export const INDUSTRY: Record<string, string> = {
  '00': 'ETF', '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '08': '玻璃陶瓷', '09': '造紙', '10': '鋼鐵', '11': '橡膠', '12': '汽車', '14': '建材營造', '15': '航運',
  '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨', '19': '綜合', '20': '其他', '21': '化學', '22': '生技醫療',
  '23': '油電燃氣', '24': '半導體', '25': '電腦及週邊設備', '26': '光電', '27': '通信網路', '28': '電子零組件',
  '29': '電子通路', '30': '資訊服務', '31': '其他電子', '32': '文化創意', '33': '農業科技', '34': '電子商務',
  '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活',
};
/** 產業代碼統一成兩位數（API 可能回 '1' 或 '01'） */
export const normCat = (c: string | undefined) => (c == null || c === '' ? '' : /^\d+$/.test(c) ? c.padStart(2, '0') : c);
export const industryName = (c: string) => INDUSTRY[normCat(c)] ?? (c ? `產業 ${c}` : '未分類');

// 只收一般股票與 ETF：4 碼股票、00 開頭 ETF（排除權證、特別股等雜項）
const WANT = /^(\d{4}|00\d{2,4}[A-Z]?)$/;
const KEY = 'catalog';
const MAX_AGE = 7 * 86400_000;

interface Saved { at: number; items: Record<string, [string, string, string]> } // code → [name, cat, ex]

class Catalog {
  private items = new Map<string, StockEntry>();
  private savedAt = 0;
  building = false;
  progress = { done: 0, total: 0 };
  private listeners = new Set<() => void>();

  constructor() {
    const s = LS.getJSON<Saved | null>(KEY, null);
    if (s?.items) {
      this.savedAt = s.at;
      for (const [code, [name, cat, ex]] of Object.entries(s.items)) this.items.set(code, { code, name, cat, ex });
    }
  }

  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f()); }
  get size() { return this.items.size; }
  get ready() { return this.items.size > 0 && !this.building; }

  /** 確保目錄存在：沒有或過期就在背景建立／補齊（重複呼叫安全） */
  async ensure() {
    if (this.building) return;
    if (this.items.size && Date.now() - this.savedAt < MAX_AGE) return;
    this.building = true;
    this.emit();
    try {
      const list = (await hub.be.stockList()).filter((c) => WANT.test(c.code));
      const todo = Date.now() - this.savedAt < MAX_AGE ? list.filter((c) => !this.items.has(c.code)) : list;
      this.progress = { done: 0, total: todo.length };
      const queue = [...todo];
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          try {
            const i = await hub.be.contractInfo(c);
            this.items.set(c.code, { code: c.code, name: i.name, cat: normCat(i.category), ex: c.exchange });
          } catch { /* 單檔失敗略過，下次補齊 */ }
          this.progress.done++;
          if (this.progress.done % 100 === 0) { this.emit(); this.save(); }
        }
      };
      await Promise.all(Array.from({ length: 12 }, worker));
      this.savedAt = Date.now();
      this.save();
    } catch (e) {
      console.warn('catalog', e);
    } finally {
      this.building = false;
      this.emit();
    }
  }

  private save() {
    const items: Saved['items'] = {};
    for (const e of this.items.values()) items[e.code] = [e.name, e.cat, e.ex];
    LS.setJSON(KEY, { at: this.savedAt || Date.now(), items });
  }

  get(code: string) { return this.items.get(code); }
  contract(code: string): Contract {
    const e = this.items.get(code);
    return { security_type: 'STK', exchange: e?.ex || 'TSE', code };
  }

  /** 代碼開頭或名稱包含（代碼完全相符排最前，再依代碼長度、名稱長度） */
  search(q: string, limit = 12): StockEntry[] {
    q = q.trim().toUpperCase();
    if (!q) return [];
    const out: [number, StockEntry][] = [];
    for (const e of this.items.values()) {
      let s = -1;
      if (e.code === q) s = 0;
      else if (e.code.startsWith(q)) s = 1;
      else if (e.name.toUpperCase().startsWith(q)) s = 2;
      else if (e.name.toUpperCase().includes(q)) s = 3;
      if (s >= 0) out.push([s * 1000 + e.code.length * 10 + Math.min(9, e.name.length), e]);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1].code.localeCompare(b[1].code)).slice(0, limit).map((x) => x[1]);
  }

  /** 類股清單：[代碼, 名稱, 檔數]，依代碼排序（ETF 放最後） */
  industries(): [string, string, number][] {
    const cnt = new Map<string, number>();
    for (const e of this.items.values()) cnt.set(e.cat, (cnt.get(e.cat) ?? 0) + 1);
    return [...cnt.entries()].map(([c, n]) => [c, industryName(c), n] as [string, string, number])
      .sort((a, b) => (a[0] === '00' ? 1 : b[0] === '00' ? -1 : a[0].localeCompare(b[0])));
  }

  byIndustry(cat: string): StockEntry[] {
    return [...this.items.values()].filter((e) => e.cat === cat).sort((a, b) => a.code.localeCompare(b.code));
  }
}

export const catalog = new Catalog();
