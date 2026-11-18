// 尚未實作的頁面：顯示「設計藍圖」，讓使用者先確認版面與內容
import type { Page } from './page';

interface Block { title: string; items: string[]; span?: number; tall?: boolean; accent?: boolean }

export function blueprintPage(id: string, title: string, intro: string, blocks: Block[], cols = 3): Page {
  return {
    id,
    title,
    mount(el) {
      el.innerHTML = `<section class="bp">
        <div class="bp-head"><b>${title}・設計藍圖</b><span>${intro}</span></div>
        <div class="bp-grid" style="--cols:${cols}">
          ${blocks.map((b) => `<div class="bp-box${b.tall ? ' tall' : ''}${b.accent ? ' accent' : ''}" style="grid-column: span ${b.span ?? 1}">
            <div class="bp-t">${b.title}</div><ul>${b.items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`).join('')}
        </div></section>`;
    },
    unmount() { /* 無資源 */ },
  };
}
