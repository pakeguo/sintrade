// 產業類股熱力圖（Canvas，60fps）
//
// - 方塊大小＝權重、顏色＝類股加權漲跌幅；大小、位置、顏色、數字都以緩動過渡
// - 資金流粒子：密度＝每秒新增成交金額（資金流量）；
//   往上飄的紅色光點＝此刻正在推升指數，往下落的綠色光點＝正在拖累指數
// - 貢獻點數突然大幅變化時，邊框閃一下光暈
// - 盤後（live=false）粒子停止，只顯示收盤值
// - 分頁隱藏或系統「減少動態效果」時自動暫停／不畫粒子
import type { Sector } from '../core/components';

interface Tile {
  key: string; s: Sector;
  x: number; y: number; w: number; h: number;          // 目前（動畫中）
  tx: number; ty: number; tw: number; th: number;      // 目標
  col: [number, number, number]; tcol: [number, number, number];
  perf: number; contrib: number;                       // 顯示用（緩動中）
  glow: number; lastContrib: number;
  spawn: number;                                       // 粒子產生的累積量
}
interface Particle { tile: Tile; x: number; y: number; vy: number; vx: number; life: number; max: number; r: number; up: boolean }

const UP: [number, number, number] = [240, 82, 79];
const DOWN: [number, number, number] = [34, 176, 125];
const FLAT: [number, number, number] = [58, 66, 78];

function colorOf(p: number): [number, number, number] {
  if (!Number.isFinite(p)) return FLAT;
  const k = Math.min(1, Math.abs(p) / 2.5) ** 0.7;   // ±2.5% 以上為最飽和
  const c = p >= 0 ? UP : DOWN;
  return [FLAT[0] + (c[0] - FLAT[0]) * k, FLAT[1] + (c[1] - FLAT[1]) * k, FLAT[2] + (c[2] - FLAT[2]) * k];
}

function squarify(items: Sector[], x: number, y: number, w: number, h: number) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  const out: { s: Sector; x: number; y: number; w: number; h: number }[] = [];
  if (!items.length || total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map((s) => ({ s, a: s.weight * scale }));
  while (rest.length) {
    const short = Math.min(w, h);
    let row: typeof rest = [];
    let best = Infinity;
    for (const it of rest) {
      const cand = [...row, it];
      const sum = cand.reduce((s, c) => s + c.a, 0);
      const mx = Math.max(...cand.map((c) => c.a)), mn = Math.min(...cand.map((c) => c.a));
      const worst = Math.max((short * short * mx) / (sum * sum), (sum * sum) / (short * short * mn));
      if (worst > best) break;
      best = worst; row = cand;
    }
    const sum = row.reduce((s, c) => s + c.a, 0);
    const thick = sum / short;
    let off = 0;
    for (const c of row) {
      const len = c.a / thick;
      out.push(w >= h ? { s: c.s, x, y: y + off, w: thick, h: len } : { s: c.s, x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    rest = rest.slice(row.length);
  }
  return out;
}

const fmtSign = (n: number, d: number) => (!Number.isFinite(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d));

export class Heatmap {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tip = document.createElement('div');
  private tiles = new Map<string, Tile>();
  private parts: Particle[] = [];
  private W = 0; H = 0; private dpr = 1;
  private raf = 0;
  private last = 0;
  private live = false;
  private ro: ResizeObserver;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private hover: Tile | null = null;
  private sprite: Record<'up' | 'down', HTMLCanvasElement>;
  private list: Sector[] = [];

  constructor(private host: HTMLElement) {
    host.classList.add('hm-host');
    this.canvas.className = 'hm-canvas';
    this.tip.className = 'hm-tip';
    this.tip.hidden = true;
    host.append(this.canvas, this.tip);
    this.sprite = { up: this.makeSprite(UP), down: this.makeSprite(DOWN) };
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.hidden = true; });
    document.addEventListener('visibilitychange', this.onVis);
    this.resize();
    this.loop(performance.now());
  }

  /** 光點貼圖（預先畫好，比每顆粒子用 shadowBlur 省效能） */
  private makeSprite(c: [number, number, number]) {
    const s = document.createElement('canvas');
    s.width = s.height = 32;
    const g = s.getContext('2d')!;
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, `rgba(255,240,230,0.9)`);
    grd.addColorStop(0.2, `rgba(${Math.min(255, c[0] + 30)},${Math.min(255, c[1] + 50)},${Math.min(255, c[2] + 50)},0.75)`);
    grd.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 32, 32);
    return s;
  }

  private onVis = () => {
    if (document.hidden) cancelAnimationFrame(this.raf);
    else { this.last = performance.now(); this.loop(this.last); }
  };

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(1, Math.floor(r.width));
    this.H = Math.max(1, Math.floor(r.height));
    this.canvas.width = this.W * this.dpr;
    this.canvas.height = this.H * this.dpr;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.layout(true);
  }

  setData(list: Sector[], live: boolean) {
    this.list = list;
    this.live = live;
    for (const s of list) {
      const t = this.tiles.get(s.category);
      if (t) {
        t.s = s;
        t.tcol = colorOf(s.perf);
        // 貢獻點數一次跳動超過「全市場最大類股貢獻的 6%」且至少 3 點 → 閃光（只標出真正的急變）
        const d = Math.abs(s.contrib - t.lastContrib);
        const ref = Math.max(...list.map((x) => Math.abs(x.contrib) || 0));
        if (Number.isFinite(d) && d > Math.max(3, ref * 0.06)) t.glow = 1;
        t.lastContrib = s.contrib;
      }
    }
    this.layout(false);
  }

  private layout(snap: boolean) {
    const rects = squarify(this.list, 0, 0, this.W, this.H);
    const seen = new Set<string>();
    for (const r of rects) {
      seen.add(r.s.category);
      let t = this.tiles.get(r.s.category);
      if (!t) {
        const col = colorOf(r.s.perf);
        t = { key: r.s.category, s: r.s, x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0, tx: r.x, ty: r.y, tw: r.w, th: r.h,
          col, tcol: col, perf: r.s.perf, contrib: r.s.contrib, glow: 0, lastContrib: r.s.contrib, spawn: 0 };
        this.tiles.set(r.s.category, t);
      }
      t.tx = r.x; t.ty = r.y; t.tw = r.w; t.th = r.h;
      if (snap) { t.x = r.x; t.y = r.y; t.w = r.w; t.h = r.h; }
    }
    for (const k of [...this.tiles.keys()]) if (!seen.has(k)) this.tiles.delete(k);
    this.parts = this.parts.filter((p) => this.tiles.has(p.tile.key));
  }

  private loop = (now: number) => {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private step(dt: number) {
    const k = 1 - Math.exp(-dt * 7);   // 緩動係數（與幀率無關）
    const tiles = [...this.tiles.values()];
    const maxFlow = Math.max(1, ...tiles.map((t) => t.s.flow || 0));
    const maxPush = Math.max(0.05, ...tiles.map((t) => Math.abs(t.s.push || 0)));
    for (const t of tiles) {
      t.x += (t.tx - t.x) * k; t.y += (t.ty - t.y) * k; t.w += (t.tw - t.w) * k; t.h += (t.th - t.h) * k;
      for (let i = 0; i < 3; i++) t.col[i] += (t.tcol[i] - t.col[i]) * k;
      if (Number.isFinite(t.s.perf)) t.perf = Number.isFinite(t.perf) ? t.perf + (t.s.perf - t.perf) * k : t.s.perf;
      if (Number.isFinite(t.s.contrib)) t.contrib = Number.isFinite(t.contrib) ? t.contrib + (t.s.contrib - t.contrib) * k : t.s.contrib;
      t.glow = Math.max(0, t.glow - dt * 1.4);
      // 產生粒子：每秒顆數 ∝ 資金流量（沒有成交金額資料時改用貢獻變化速度）
      if (!this.live || this.reduced.matches || t.tw < 18 || t.th < 18) continue;
      const flowN = t.s.flow > 0 ? t.s.flow / maxFlow : Math.abs(t.s.push || 0) / maxPush;
      const area = Math.sqrt(t.tw * t.th) / 60;
      t.spawn += dt * (0.8 + flowN * 14) * Math.min(2.2, Math.max(0.5, area));
      const up = (t.s.push || 0) !== 0 ? t.s.push > 0 : (t.s.perf || 0) >= 0;
      const speed = 18 + 70 * Math.min(1, Math.abs(t.s.push || 0) / maxPush + flowN * 0.4);
      while (t.spawn >= 1 && this.parts.length < 360) {
        t.spawn -= 1;
        const life = 1.4 + Math.random() * 1.6;
        this.parts.push({ tile: t, up, life, max: life, r: 0.9 + Math.random() * 1.4 * (0.6 + flowN),
          x: t.tx + Math.random() * t.tw, y: up ? t.ty + t.th * (0.7 + Math.random() * 0.3) : t.ty + t.th * Math.random() * 0.3,
          vy: (up ? -1 : 1) * speed * (0.6 + Math.random() * 0.8), vx: (Math.random() - 0.5) * 8 });
      }
    }
    for (const p of this.parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    this.parts = this.parts.filter((p) => p.life > 0 && p.y > p.tile.y - 4 && p.y < p.tile.y + p.tile.h + 4);
  }

  private draw() {
    const c = this.ctx, d = this.dpr;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    const gap = 2;
    for (const t of this.tiles.values()) {
      const x = t.x + gap / 2, y = t.y + gap / 2, w = Math.max(0, t.w - gap), h = Math.max(0, t.h - gap);
      if (w < 1 || h < 1) continue;
      const [r, g, b] = t.col;
      // 底色：上亮下暗的漸層，增加立體感
      const grd = c.createLinearGradient(0, y, 0, y + h);
      grd.addColorStop(0, `rgb(${r * 1.12 | 0},${g * 1.12 | 0},${b * 1.12 | 0})`);
      grd.addColorStop(1, `rgb(${r * 0.78 | 0},${g * 0.78 | 0},${b * 0.78 | 0})`);
      c.fillStyle = grd;
      this.round(x, y, w, h, 5);
      c.fill();
      // 粒子（裁切在方塊內）
      c.save();
      this.round(x, y, w, h, 5);
      c.clip();
      c.globalCompositeOperation = 'lighter';
      for (const p of this.parts) {
        if (p.tile !== t) continue;
        const a = Math.min(1, p.life / 0.4, (p.max - p.life) / 0.3);
        c.globalAlpha = a * 0.55;
        const s = p.r * 4.5;
        c.drawImage(this.sprite[p.up ? 'up' : 'down'], p.x - s / 2, p.y - s / 2, s, s);
      }
      c.restore();
      c.globalAlpha = 1;
      // 光暈（貢獻急變）與滑鼠停留外框
      if (t.glow > 0.01 || t === this.hover) {
        c.save();
        c.shadowColor = t === this.hover ? 'rgba(255,255,255,.6)' : `rgba(245,185,74,${t.glow})`;
        c.shadowBlur = 14 * Math.max(t.glow, 0.6);
        c.strokeStyle = t === this.hover ? 'rgba(255,255,255,.85)' : `rgba(245,185,74,${0.4 + t.glow * 0.6})`;
        c.lineWidth = 2;
        this.round(x + 1, y + 1, w - 2, h - 2, 5);
        c.stroke();
        c.restore();
      }
      this.label(t, x, y, w, h);
    }
  }

  private label(t: Tile, x: number, y: number, w: number, h: number) {
    if (w < 40 || h < 20) return;
    const c = this.ctx;
    const big = w > 110 && h > 70;
    const name = t.s.name.replace(/業$/, '').replace('及週邊設備', '週邊');
    const fs = big ? Math.min(18, Math.max(12, Math.sqrt(w * h) / 9)) : 11;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0,0,0,.55)';
    c.shadowBlur = 3;
    c.fillStyle = '#fff';
    const cx = x + w / 2, cy = y + h / 2;
    if (h < 44 || w < 70) {
      c.font = `600 ${11}px system-ui, "Noto Sans TC", sans-serif`;
      c.fillText(this.fit(name, w - 6), cx, cy);
    } else {
      c.font = `600 ${fs * 0.8}px system-ui, "Noto Sans TC", sans-serif`;
      c.fillText(this.fit(name, w - 8), cx, cy - fs * (big ? 1.05 : 0.6));
      c.font = `700 ${fs * (big ? 1.25 : 1)}px system-ui, sans-serif`;
      c.fillText(`${fmtSign(t.perf, 2)}%`, cx, cy + (big ? 0 : fs * 0.4));
      if (big) {
        c.font = `500 ${fs * 0.72}px system-ui, "Noto Sans TC", sans-serif`;
        c.globalAlpha = 0.9;
        c.fillText(`${fmtSign(t.contrib, 1)} 點`, cx, cy + fs * 1.15);
        c.globalAlpha = 1;
      }
    }
    c.shadowBlur = 0;
  }

  private fit(s: string, w: number) {
    const c = this.ctx;
    if (c.measureText(s).width <= w) return s;
    while (s.length > 1 && c.measureText(s + '…').width > w) s = s.slice(0, -1);
    return s + '…';
  }

  private round(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx;
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  private onMove(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    this.hover = [...this.tiles.values()].find((t) => mx >= t.tx && mx < t.tx + t.tw && my >= t.ty && my < t.ty + t.th) ?? null;
    if (!this.hover) { this.tip.hidden = true; return; }
    const s = this.hover.s;
    const flow = s.flow > 0 ? `${(s.flow / 1e6).toFixed(1)} 百萬/秒` : '—';
    this.tip.innerHTML = `<b>${s.name}</b><span>權重 ${s.weight.toFixed(1)}%</span>
      <span>漲跌 ${fmtSign(s.perf, 2)}%</span><span>貢獻 ${fmtSign(s.contrib, 1)} 點</span>
      ${this.live ? `<span>資金流量 ${flow}</span>` : ''}${Number.isFinite(s.amount) ? `<span>成交 ${(s.amount / 1e8).toFixed(0)} 億</span>` : ''}`;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = Math.min(this.W - tw - 4, mx + 14) + 'px';
    this.tip.style.top = Math.min(this.H - th - 4, my + 14) + 'px';
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    this.canvas.remove();
    this.tip.remove();
    this.host.classList.remove('hm-host');
  }
}
