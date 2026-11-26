import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import type { Plugin } from 'vite';

// 下單防堵（建置層）：輸出檔裡只要出現送單路徑或下單函式名稱就讓建置失敗（core/guard.ts、docs/ai/decisions.md）
const FORBIDDEN = ['v1/order', 'place_order', 'cancel_order', 'update_price', 'update_qty', 'placeOrder', 'cancelOrder', 'subscribe_trade'];
function noOrderCode(): Plugin {
  return {
    name: 'no-order-code',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      for (const [file, out] of Object.entries(bundle)) {
        const code = out.type === 'chunk' ? out.code : typeof out.source === 'string' ? out.source : '';
        const hit = FORBIDDEN.find((w) => code.includes(w));
        if (hit) this.error(`下單防堵：${file} 含有「${hit}」，本專案目前禁止任何送單程式碼（見 core/guard.ts）`);
      }
    },
  };
}

// 打包成單一 index.html（JS/CSS 全部內嵌），上傳到 shioaji server 不會有子目錄或 base 路徑問題
export default defineConfig({
  base: './',
  plugins: [viteSingleFile(), noOrderCode()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true } },
  },
});
