// 問題偵測器：程式錯誤、卡住主執行緒（長任務）、各區塊繪製耗時 → 畫面頂端紅色提示列
// 目的：使用者回報「點不動／卡住」時，截圖就能看出原因（pitfalls #17）
const events: string[] = [];
let bar: HTMLElement | null = null;
const tpe = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19);

function show(msg: string) {
  events.push(`${tpe()} ${msg}`);
  if (events.length > 6) events.shift();
  console.warn('[診斷]', msg);
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'diag-bar';
    bar.title = '點一下關閉';
    bar.addEventListener('click', () => { bar!.hidden = true; events.length = 0; });
    document.body.prepend(bar);
  }
  bar.hidden = false;
  bar.innerHTML = `<b>⚠ 問題偵測（請截圖給 Claude）</b>　頁面 ${location.hash || '#/'}<br>${events.map((e) => e.replace(/</g, '&lt;')).join('<br>')}`;
}

export function initDiag() {
  window.addEventListener('error', (e) => show(`錯誤：${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => show(`未處理錯誤：${String((e.reason as Error)?.stack ?? e.reason).split('\n').slice(0, 2).join(' | ')}`));
  // 點擊落在「蓋住大半畫面」的元素上 → 回報它的身分、大小與定位鏈（找出擋住點擊的元凶）
  document.addEventListener('pointerdown', (e) => {
    const el = e.target as HTMLElement;
    if (!el?.getBoundingClientRect || el === document.body || el === document.documentElement) return;
    const r = el.getBoundingClientRect();
    const tag = `${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')}${el.id ? '#' + el.id : ''}`;
    const big = r.width * r.height > innerWidth * innerHeight * 0.4;
    const outside = !el.closest('a,button,input,select,label,canvas,table,.card,header,.wl,.sh') ;
    const overlay = ['absolute', 'fixed'].includes(getComputedStyle(el).position);
    if (big && outside && overlay) {
      const chain: string[] = [];
      for (let x: HTMLElement | null = el; x && x !== document.body && chain.length < 6; x = x.parentElement) {
        chain.push(`${x.tagName.toLowerCase()}.${String(x.className).split(' ')[0]}(${getComputedStyle(x).position})`);
      }
      show(`點擊被 ${tag} 攔截：${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}｜${chain.join(' < ')}`);
    }
  }, true);
  try {
    new PerformanceObserver((list) => {
      for (const en of list.getEntries()) if (en.duration > 1500) show(`畫面卡住 ${Math.round(en.duration)} ms（${lastSection || '未知區塊'}）`);
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* 瀏覽器不支援 longtask */ }
}

let lastSection = '';
/** 包住一段繪製：出錯不影響其他區塊；超過 150ms 記錄區塊名稱 */
export function section(name: string, fn: () => void) {
  lastSection = name;
  const t0 = performance.now();
  try { fn(); } catch (e) { show(`${name} 出錯：${String((e as Error)?.stack ?? e).split('\n').slice(0, 2).join(' | ')}`); }
  const dt = performance.now() - t0;
  if (dt > 300) show(`${name} 繪製耗時 ${Math.round(dt)} ms`);
  lastSection = '';
}
