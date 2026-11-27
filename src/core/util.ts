// 共用小工具：格式化、台北時間、交易時段、本機儲存、重試

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const LS = {
  get: (k: string) => { try { return localStorage.getItem('mw.' + k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem('mw.' + k, v); } catch { /* ignore */ } },
  getJSON<T>(k: string, def: T): T {
    try { const s = localStorage.getItem('mw.' + k); return s ? JSON.parse(s) as T : def; } catch { return def; }
  },
  setJSON(k: string, v: unknown) { try { localStorage.setItem('mw.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ── 數字格式（台灣慣例：紅漲綠跌） ──
export const fin = (n: number) => Number.isFinite(n);
export function fmt(n: number, d = 0): string {
  if (!fin(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtP(n: number): string {
  if (!fin(n)) return '—';
  return n >= 100 ? fmt(n, 0) : n >= 10 ? fmt(n, 1) : fmt(n, n % 1 ? (Math.round(n * 10) === n * 10 ? 1 : 2) : 1);
}
export function sign(n: number, d = 0) { return !fin(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d); }
export const cls = (n: number) => (!fin(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down');
export function fmtVol(n: number) {
  if (!fin(n) || n <= 0) return '';
  return n >= 10000 ? (n / 10000).toFixed(1) + '萬' : fmt(n);
}
export function avg(a: number[]) {
  const v = a.filter(fin);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ── 台北時間 ──
export const tpeNow = () => new Date(Date.now() + 8 * 3600_000); // 用 getUTC* 讀台北時間
export function tpeToday(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}
export function tpeMinutes() { const t = tpeNow(); return t.getUTCHours() * 60 + t.getUTCMinutes(); }

/** 期貨交易時段（日盤 08:45–13:45、夜盤 15:00–05:00） */
export function session(): 'day' | 'night' | 'closed' {
  const t = tpeNow();
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  const wd = t.getUTCDay();
  if (wd >= 1 && wd <= 5 && mins >= 8 * 60 + 45 && mins < 13 * 60 + 45) return 'day';
  if ((wd >= 1 && wd <= 5 && mins >= 15 * 60) || (wd >= 2 && wd <= 6 && mins < 5 * 60)) return 'night';
  return 'closed';
}

/** 到期日當天 13:30 最後交易時刻之後就算到期（docs/ai/pitfalls.md #1） */
export function isLive(deliveryDate: string): boolean {
  const today = tpeToday();
  if (deliveryDate > today) return true;
  if (deliveryDate < today) return false;
  return tpeMinutes() < 13 * 60 + 30;
}

export function cssVar(n: string) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

export const compactMq = window.matchMedia('(max-width: 1000px)');

export function errText(e: unknown) {
  const s = String((e as Error)?.message ?? e);
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

/** shioaji server 剛啟動或與永豐主機暫時斷線（NotReady）時會回 500：自動重試直到成功（pitfalls #7） */
export async function retry<T>(label: string, fn: () => Promise<T>, show: (html: string) => void): Promise<T> {
  let delay = 2000;
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      console.warn(label, e);
      const notReady = /NotReady|transient|transport|503|500/i.test(String((e as Error)?.message ?? e));
      show(`<b>${label}失敗，${Math.round(delay / 1000)} 秒後自動重試（第 ${n} 次）</b><br>
        ${notReady ? 'shioaji server 與永豐主機的連線尚未就緒，通常等一下就會恢復。<br>若持續失敗，請重新啟動 shioaji server，或參考 docs/ai/pitfalls.md #7。<br>' : ''}
        <small>${esc(errText(e))}</small>`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30_000);
    }
  }
}

// ── 按住滑鼠／手指時暫停重繪 ──
// 即時行情每 0.2–0.5 秒重繪一次畫面；若在「按下」與「放開」之間把按鈕換掉，瀏覽器就不會觸發 click
// （pitfalls #12）。各頁的 frame() 在 pointerHeld() 為 true 時先不重繪，放開後再補畫。
let pressed = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { pressed = true; }, true);
  const release = () => { setTimeout(() => { pressed = false; }, 0); }; // 讓 click 先處理完
  for (const ev of ['pointerup', 'pointercancel', 'dragend']) document.addEventListener(ev, release, true);
  window.addEventListener('blur', release);
}
export const pointerHeld = () => pressed;

/**
 * 永豐回傳的日期格式不一致（帳戶別、API 不同）→ 一律轉成 YYYY-MM-DD（pitfalls #23）
 * 支援：2026-11-18、2026/11/18、20261118、2026-11-18T09:00:00、2026-11-18 09:00、民國 115/11/18、1151118
 */
export function normDate(x: unknown): string {
  const s = String(x ?? '').trim();
  let m = s.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/);
  if (m && (s[4] === '-' || s[4] === '/' || s[4] === '.' || /^\d{8}/.test(s))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{2,3})[-/.]?(\d{2})[-/.]?(\d{2})(?!\d)/);   // 民國年
  if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  return s.slice(0, 10);
}

/** 把捲動容器內的某一列捲到容器正中間（T 字報價「置中」用；只捲容器，不動整頁） */
export function scrollRowToCenter(wrap: Element | null, row: Element | null, smooth = true) {
  if (!wrap || !row) return;
  const w = wrap.getBoundingClientRect(), r = row.getBoundingClientRect();
  const top = wrap.scrollTop + (r.top - w.top) - (wrap.clientHeight - r.height) / 2;
  wrap.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}
