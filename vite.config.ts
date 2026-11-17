import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 打包成單一 index.html（JS/CSS 全部內嵌），上傳到 shioaji server 不會有子目錄或 base 路徑問題
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true } },
  },
});
