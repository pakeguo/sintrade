// 報價頁的股票搜尋列＋「選股」彈出視窗（類股／成交量前 50／成交值前 50／外資、投信買超與賣超）
// 加入的對象＝自選群組（store.groups，電腦手機同步）
import { catalog, industryName } from '../core/catalog';
import { hub } from '../core/hub';
import { openTA } from '../core/nav';
import { store } from '../core/store';
import { cls, esc, fin, fmt, fmtP, LS, sign } from '../core/util';
import { loadInst } from '../core/inst';
import type { Contract, ScanRow } from '../types';

type Tab = 'ind' | 'vol' | 'amt' | 'fi' | 'fs' | 'it' | 'is';
const INST: Tab[] = ['fi', 'fs', 'it', 'is'];
const INST_TAB: Record<string, { key: 'foreign' | 'trust'; sell: boolean; who: string }> = {
  fi: { key: 'foreign', sell: false, who: '外資' }, fs: { key: 'foreign', sell: true, who: '外資' },
  it: { key: 'trust', sell: false, who: '投信' }, is: { key: 'trust', sell: true, who: '投信' },
};

type Row = { code: string; name: string; close: number; pct: number; volume: number; amount: number; foreign?: number; trust?: number };
let closeCache: { at: number; rows: Row[] } | null = null;
/** 收盤後永豐排行（scanner）沒有資料 → 用全市場快照（收盤數據）自己排 */
async function closeRows(): Promise<Row[]> {
  if (closeCache && Date.now() - closeCache.at < 10 * 60_000) return closeCache.rows;
  const list = (await hub.be.stockList()).filter((c) => /^\d{4,6}[A-Z]?$/.test(c.code));
  const snaps = await hub.be.snapshots(list);
  const rows = snaps.filter((x) => x.total_volume > 0 && x.close > 0).map((x) => ({
    code: x.code, name: catalog.get(x.code)?.name || x.code, close: x.close,
    pct: (x.change_price / (x.close - x.change_price)) * 100, volume: x.total_volume, amount: x.total_amount,
  }));
  closeCache = { at: Date.now(), rows };
  return rows;
}

export class Picker {
  private target: string;
  private modal: HTMLElement | null = null;
  private tab: Tab = (LS.get('pkTab') as Tab) ?? 'ind';
  private cat = LS.get('pkCat') ?? '24';
  private seq = 0;
  private offs: (() => void)[] = [];

  /** defaultTarget：目前所在的自訂頁籤（固定頁籤時為 null → 用第一個群組） */
  constructor(private host: HTMLElement, defaultTarget: string | null) {
    this.target = defaultTarget ?? store.data.groups[0]?.id ?? '';
    host.innerHTML = `
      <div class="pk-search"><input id="pk-q" placeholder="搜尋股票：代碼或名稱，Enter 加入" autocomplete="off">
        <div id="pk-sug" class="pk-sug" hidden></div></div>
      <button id="pk-open" class="pk-btn" title="依類股、成交量、成交值挑選">☰ 選股</button>
      <label class="pk-to">加入到 <select id="pk-target"></select></label>
      <span id="pk-status" class="muted pk-status"></span>`;
    this.renderTargets();
    const q = host.querySelector<HTMLInputElement>('#pk-q')!;
    q.addEventListener('input', () => this.suggest(q.value));
    q.addEventListener('focus', () => { catalog.ensure(); this.suggest(q.value); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { q.value = ''; this.suggest(''); }
      if (e.key !== 'Enter') return;
      const first = host.querySelector<HTMLElement>('#pk-sug [data-code]')?.dataset.code ?? q.value.trim().toUpperCase();
      if (/^[0-9A-Z]{4,6}$/.test(first)) { this.add(first); q.value = ''; this.suggest(''); }
    });
    q.addEventListener('blur', () => setTimeout(() => this.suggest(''), 150));
    host.querySelector('#pk-sug')!.addEventListener('mousedown', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-code]');
      if (!el) return;
      e.preventDefault();
      if ((e.target as HTMLElement).closest('[data-open]')) openTA(catalog.contract(el.dataset.code!));
      else { this.add(el.dataset.code!); q.value = ''; this.suggest(''); }
    });
    host.querySelector('#pk-open')!.addEventListener('click', () => this.openModal());
    host.querySelector('#pk-target')!.addEventListener('change', (e) => { this.target = (e.target as HTMLSelectElement).value; this.renderModal(); });
    this.offs.push(catalog.on(() => this.renderStatus()), store.on(() => { this.renderTargets(); this.renderModal(); }));
    this.renderStatus();
  }

  /** 切換頁籤時：在自訂頁籤就預設加入該頁籤 */
  setTarget(id: string | null) {
    if (id && store.data.groups.some((g) => g.id === id)) { this.target = id; this.renderTargets(); }
  }

  private group() { return store.data.groups.find((g) => g.id === this.target) ?? store.data.groups[0]; }
  private has(code: string) { return !!this.group()?.codes.includes(code); }

  private add(code: string) {
    const g = this.group();
    if (!g || g.codes.includes(code)) { this.flash(`${this.label(code)} 已在「${g?.name ?? ''}」`); return; }
    store.update(() => { g.codes.push(code); });
    this.flash(`已加入「${g.name}」：${this.label(code)}`);
  }
  private toggle(code: string) {
    const g = this.group();
    if (!g) return;
    store.update(() => { g.codes = g.codes.includes(code) ? g.codes.filter((c) => c !== code) : [...g.codes, code]; });
  }
  private label(code: string) { const e = catalog.get(code); return e ? `${e.name} ${code}` : code; }

  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flash(msg: string) {
    const el = this.host.querySelector('#pk-status');
    if (!el) return;
    el.textContent = msg; el.classList.add('accent');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { el.classList.remove('accent'); this.renderStatus(); }, 2500);
  }

  private renderStatus() {
    const el = this.host.querySelector('#pk-status');
    if (!el || el.classList.contains('accent')) return;
    el.textContent = catalog.building
      ? `建立股票名稱索引中… ${catalog.progress.done}/${catalog.progress.total}（第一次約 1–2 分鐘，之後免等）`
      : catalog.size ? `${store.synced ? '✓ 電腦手機同步' : '只存在這個瀏覽器'}` : '';
    if (this.modal) this.renderModal();
  }

  private renderTargets() {
    const sel = this.host.querySelector<HTMLSelectElement>('#pk-target');
    if (!sel) return;
    if (!store.data.groups.some((g) => g.id === this.target)) this.target = store.data.groups[0]?.id ?? '';
    sel.innerHTML = store.data.groups.map((g) => `<option value="${g.id}">${esc(g.name)}（${g.codes.length}）</option>`).join('');
    sel.value = this.target;
  }

  private suggest(q: string) {
    const box = this.host.querySelector<HTMLElement>('#pk-sug');
    if (!box) return;
    q = q.trim();
    if (!q) { box.hidden = true; return; }
    const hits = catalog.search(q, 10);
    const raw = q.toUpperCase();
    const exact = /^[0-9A-Z]{4,6}$/.test(raw) && !hits.some((h) => h.code === raw);
    box.innerHTML = (exact ? `<div data-code="${esc(raw)}"><b>${esc(raw)}</b><span class="muted">加入</span></div>` : '') +
      hits.map((h) => `<div data-code="${h.code}"><b>${esc(h.name)}</b><small>${h.code}</small>
        <span class="muted">${esc(industryName(h.cat))}</span><em>${this.has(h.code) ? '✓ 已加入' : '＋ 加入'}</em>
        <button data-open title="看技術分析">↗</button></div>`).join('') +
      (catalog.building ? `<div class="muted pk-note">名稱索引建立中（${catalog.progress.done}/${catalog.progress.total}），可先輸入代碼</div>` : '');
    box.hidden = !box.innerHTML;
  }

  // ───────── 選股視窗 ─────────
  private openModal() {
    catalog.ensure();
    this.modal?.remove();
    const m = document.createElement('div');
    m.className = 'pk-modal-bg';
    m.innerHTML = `<div class="pk-modal" role="dialog">
      <div class="pk-head"><b>選股</b>
        <div class="seg" id="pk-tabs"><button data-t="ind">類股</button><button data-t="vol">成交量前 50</button><button data-t="amt">成交值前 50</button><button data-t="fi">外資買超</button><button data-t="fs">外資賣超</button><button data-t="it">投信買超</button><button data-t="is">投信賣超</button></div>
        <span class="pk-to2">加入到 <b id="pk-tname"></b></span><button class="pk-x" title="關閉（Esc）">✕</button></div>
      <div id="pk-body" class="pk-body"></div></div>`;
    document.body.append(m);
    this.modal = m;
    m.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === m || t.closest('.pk-x')) { this.closeModal(); return; }
      const tab = t.closest<HTMLElement>('[data-t]')?.dataset.t as Tab | undefined;
      if (tab) { this.tab = tab; LS.set('pkTab', tab); this.renderModal(true); return; }
      const cat = t.closest<HTMLElement>('[data-cat]')?.dataset.cat;
      if (cat != null) { this.cat = cat; LS.set('pkCat', cat); this.renderModal(true); return; }
      const row = t.closest<HTMLElement>('[data-code]');
      if (!row) return;
      if (t.closest('[data-open]')) { this.closeModal(); openTA(catalog.contract(row.dataset.code!)); return; }
      this.toggle(row.dataset.code!);
    });
    document.addEventListener('keydown', this.onKey);
    this.renderModal(true);
  }
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.closeModal(); };
  private closeModal() {
    this.modal?.remove(); this.modal = null;
    document.removeEventListener('keydown', this.onKey);
  }

  private rows: Row[] = [];
  private instDate = '';
  private fromClose = false;
  private rowsKey = '';

  /** reload=true 時重新抓資料（換分頁、換類股），否則只重畫勾選狀態 */
  private async renderModal(reload = false) {
    const m = this.modal;
    if (!m) return;
    m.querySelectorAll<HTMLElement>('#pk-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === this.tab));
    m.querySelector('#pk-tname')!.textContent = this.group()?.name ?? '';
    const body = m.querySelector<HTMLElement>('#pk-body')!;
    const key = this.tab === 'ind' ? `ind:${this.cat}:${catalog.size}` : this.tab;
    if (reload || key !== this.rowsKey) {
      this.rowsKey = key;
      const seq = ++this.seq;
      body.innerHTML = this.frame('<div class="muted pk-note">載入中…</div>');
      try {
        if (this.tab === 'ind') {
          const list = catalog.byIndustry(this.cat).slice(0, 300);
          this.rows = list.map((e) => ({ code: e.code, name: e.name, close: NaN, pct: NaN, volume: NaN, amount: NaN }));
          if (list.length) {
            const snaps = await hub.be.snapshots(list.map((e) => catalog.contract(e.code)));
            for (const s of snaps) {
              const r = this.rows.find((x) => x.code === s.code);
              if (r) { r.close = s.close; r.pct = (s.change_price / (s.close - s.change_price)) * 100; r.volume = s.total_volume; r.amount = s.total_amount; }
            }
            this.rows.sort((a, b) => (fin(b.amount) ? b.amount : -1) - (fin(a.amount) ? a.amount : -1));
          }
        } else if (INST.includes(this.tab)) {
          // 盤後資訊：最近一個有公布的交易日；不含 ETF（代號 00 開頭），依買超張數排序取前 50
          const d = await loadInst();
          const { key: k, sell } = INST_TAB[this.tab];
          const top = d.rows.filter((x) => !x.code.startsWith('00') && (sell ? x[k] < 0 : x[k] > 0))
            .sort((a, b) => (sell ? a[k] - b[k] : b[k] - a[k])).slice(0, 50);
          this.instDate = d.date;
          this.rows = top.map((x) => ({ code: x.code, name: x.name || catalog.get(x.code)?.name || x.code, close: NaN, pct: NaN, volume: NaN, amount: NaN,
            foreign: x.foreign / 1000, trust: x.trust / 1000 }));
          const snaps = await hub.be.snapshots(top.map((x): Contract => ({ security_type: 'STK', exchange: x.mkt, code: x.code }))).catch(() => []);
          for (const s of snaps) {
            const r = this.rows.find((x) => x.code === s.code);
            if (r) { r.close = s.close; r.pct = (s.change_price / (s.close - s.change_price)) * 100; r.volume = s.total_volume; r.amount = s.total_amount; }
          }
        } else {
          const r: ScanRow[] = await hub.be.scanner(this.tab === 'vol' ? 'VolumeRank' : 'AmountRank', true, 50).catch(() => []);
          this.rows = r.map((x) => ({ code: x.code, name: x.name || catalog.get(x.code)?.name || x.code, close: x.close, pct: x.pct, volume: x.volume, amount: x.amount }));
          this.fromClose = !this.rows.length;
          if (this.fromClose) {
            const all = await closeRows();
            const k = this.tab === 'vol' ? 'volume' : 'amount';
            this.rows = [...all].sort((a, b) => b[k] - a[k]).slice(0, 50);
          }
        }
      } catch (e) {
        if (seq === this.seq) body.innerHTML = this.frame(`<div class="note pk-note">查詢失敗：${esc(String((e as Error)?.message ?? e))}</div>`);
        return;
      }
      if (seq !== this.seq || !this.modal) return;
    }
    body.innerHTML = this.frame(this.table());
  }

  private frame(right: string) {
    if (this.tab !== 'ind') return `<div class="pk-list full">${right}</div>`;
    const inds = catalog.industries();
    const left = inds.length
      ? inds.map(([c, n, k]) => `<button class="pk-cat${c === this.cat ? ' on' : ''}" data-cat="${esc(c)}">${esc(n)}<small>${k}</small></button>`).join('')
      : `<div class="muted pk-note">${catalog.building ? `建立類股索引中… ${catalog.progress.done}/${catalog.progress.total}` : '載入中…'}</div>`;
    return `<div class="pk-cats">${left}</div><div class="pk-list">${right}</div>`;
  }

  private table() {
    if (!this.rows.length) return `<div class="muted pk-note">${this.tab === 'ind' ? (catalog.building ? '索引建立中，稍後自動出現…' : '這個類股沒有資料') : '沒有資料（非交易時段可能沒有排行）'}</div>`;
    const rank = this.tab !== 'ind';
    if (INST.includes(this.tab)) return this.instTable();
    return (rank && this.fromClose ? '<div class="muted pk-note pk-inst">盤中排行目前沒有資料 → 改用全市場收盤快照計算（最近一個交易日的收盤數據）</div>' : '') + `<table class="grid pk-t"><thead><tr>${rank ? '<th>#</th>' : ''}<th>股票</th><th class="r">成交</th><th class="r">漲跌幅</th>
      <th class="r">成交量</th><th class="r">成交值</th><th></th></tr></thead><tbody>
      ${this.rows.map((r, i) => `<tr data-code="${esc(r.code)}" class="${this.has(r.code) ? 'in' : ''}">
        ${rank ? `<td class="muted">${i + 1}</td>` : ''}
        <td><b>${esc(r.name)}</b> <small class="muted">${esc(r.code)}</small> <button data-open class="pk-o" title="看技術分析">↗</button></td>
        <td class="r b ${cls(r.pct)}">${fmtP(r.close)}</td>
        <td class="r ${cls(r.pct)}">${fin(r.pct) ? sign(r.pct, 2) + '%' : '—'}</td>
        <td class="r">${fin(r.volume) ? fmt(r.volume) : '—'}</td>
        <td class="r">${fin(r.amount) ? (r.amount / 1e8).toFixed(1) + '億' : '—'}</td>
        <td class="r pk-add">${this.has(r.code) ? '✓ 已加入' : '＋ 加入'}</td></tr>`).join('')}
      </tbody></table>`;
  }

  private instTable() {
    const [y, m, d] = this.instDate.split('-');
    const lots = (v?: number) => (v == null || !fin(v) ? '—' : `<span class="${cls(v)}">${v > 0 ? '+' : ''}${fmt(Math.round(v))}</span>`);
    const { key, sell, who } = INST_TAB[this.tab];
    return `<div class="muted pk-note pk-inst">${y ? `資料日期 ${+m}/${+d}（${+y - 1911} 年）` : ''}・盤後資訊，證交所／櫃買約 16:00 後公布・不含 ETF・依${who}${sell ? '賣超' : '買超'}張數排序</div>
      <table class="grid pk-t"><thead><tr><th>#</th><th>股票</th><th class="r">成交</th><th class="r">漲跌幅</th>
      <th class="r${key === 'foreign' ? ' on' : ''}">外資（張）</th><th class="r${key === 'trust' ? ' on' : ''}">投信（張）</th><th></th></tr></thead><tbody>
      ${this.rows.map((r, i) => `<tr data-code="${esc(r.code)}" class="${this.has(r.code) ? 'in' : ''}">
        <td class="muted">${i + 1}</td>
        <td><b>${esc(r.name)}</b> <small class="muted">${esc(r.code)}</small> <button data-open class="pk-o" title="看技術分析">↗</button></td>
        <td class="r b ${cls(r.pct)}">${fmtP(r.close)}</td>
        <td class="r ${cls(r.pct)}">${fin(r.pct) ? sign(r.pct, 2) + '%' : '—'}</td>
        <td class="r${key === 'foreign' ? ' b' : ''}">${lots(r.foreign)}</td>
        <td class="r${key === 'trust' ? ' b' : ''}">${lots(r.trust)}</td>
        <td class="r pk-add">${this.has(r.code) ? '✓ 已加入' : '＋ 加入'}</td></tr>`).join('')}
      </tbody></table>`;
  }

  destroy() {
    this.closeModal();
    this.offs.forEach((f) => f());
    clearTimeout(this.flashTimer);
  }
}
