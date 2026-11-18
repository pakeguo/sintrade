# 專案概況（給 AI 讀）

## 目標

取代永豐 e-Leader，做一套「主觀、直觀、好用」的個人看盤軟體。
使用者以臺指選擇權／台指期為主要交易標的，也看個股與帳務。

## 執行架構

```
瀏覽器（電腦）──▶ shioaji server（127.0.0.1:8080）
                    ├─ /apps/mywatch/   本專案打包後的單一 index.html
                    ├─ /api/v1/*        商品檔、快照、K 線、帳務…
                    └─ /api/v1/stream/data   SSE 即時行情（單一連線帶所有事件）

手機 ──▶ phone-server.mjs（電腦 0.0.0.0:5180，密碼 + API 白名單）──▶ shioaji server
         出門在外透過 Tailscale 連回家中電腦
```

- shioaji server：永豐官方 CLI（`shioaji server start`），Rust 實作，讀取執行目錄的 `.env` 登入。
- 前端：Vite + TypeScript（無框架）+ lightweight-charts 5，`vite-plugin-singlefile` 打包成單一 HTML。
- 部署：`npm.cmd run deploy` = 建置 + `curl` 上傳到 server 的 `/api/v1/apps/mywatch`。

## 程式結構（2026-11-18 架構重整後）

```
src/
  main.ts            App 外框：頁籤路由（#/overview #/stocks #/options #/account）、全域報價列、連線狀態、時鐘
  core/
    hub.ts           行情中心：backend 選擇、SSE 事件 → 報價快取 Q、訂閱引用計數 acquire/release、
                     加權指數、台指期近月與自動換月（pickFuture/setFuture/rollFuture）
    util.ts          格式化、台北時間、交易時段 session()、到期判斷 isLive()、LS 儲存、retry()
    optchain.ts      臺指選擇權共用：到期日清單、T 字列、合成期貨、computeMetrics()（期權頁與總覽共用）
    components.ts    權值股前 20（權重快取於 localStorage）、產業類股（index_components 串流），use/unuse 引用計數
    store.ts         使用者設定（自選群組、大單門檻）：經 phone-server 開啟時存 mywatch-store.json（電腦手機同步），否則 localStorage
    indicators.ts    toDaily/regroup、SMA、布林、RSI、VWAP、分價量表
    account.ts       帳務服務：15 秒查詢 margin/position_unit/profit_loss/settlements；
                     期權部位代碼（TXO20261228000C）對應實際合約後即時計算損益；證券庫存用即時 tick
  pages/
    page.ts          Page 介面：mount(el) / unmount()（離開頁面必須 releaseAll 退訂、清計時器）
    options.ts       期權頁（完成）
    overview.ts      總覽（完成）：大盤｜台指期｜期權摘要、走勢疊圖、權值股前 10、類股熱力圖、帳戶三區
    account.ts       帳務（完成）：權益風險、組合 Greeks、期權部位、到期損益圖（SVG）、證券庫存、自選期間已實現損益
    stocks.ts        個股（完成）：自選群組（拖曳、同步）、盤中（分時+VWAP、五檔、內外盤、大單三級、逐筆）、
                     K 線（日週月、MA、布林、RSI、分價量表）
    blueprint.ts     藍圖頁產生器
  api.ts             LiveBackend：HTTP + SSE
  mock.ts            DemoBackend：假資料（?demo=1）
  bs.ts              Black-76
  types.ts           型別與 Backend 介面
  style.css          深色主題、紅漲綠跌、頁籤、手機版面
phone-server.mjs     轉接站（白名單：行情＋帳務查詢；封鎖 /order/*）；/mw/store 設定同步；本機 127.0.0.1 免密碼
                     → 建議電腦也用 http://localhost:5180 開啟，自選清單才會與手機同步
```

### 規則

- 頁面不可直接呼叫 `hub.be.subscribe`，一律用 `hub.acquire(owner, contract, types)`，unmount 時 `hub.releaseAll(owner)`。
  shioaji 訂閱上限約 200，期權頁 ±10 檔就佔約 84 個。
- 台指期一律用 `hub.fut` / `hub.futKey` / `hub.futName`，監聽 `hub.on('fut', …)` 處理換月。
- 報價讀 `hub.quotes.get(code)`；有變動時 `hub.on('change')` 觸發，頁面自行節流重繪（目前 200ms）。

## 使用者環境

- Windows 11，專案位於 `G:\sintrade`，`.env` 也在這裡（已 gitignore）。
- shioaji 以 `uv tool install` 安裝於 `%USERPROFILE%\.local\bin`（已加入使用者 PATH）。
- PowerShell 執行原則會擋 `npm.ps1` → 一律用 `npm.cmd`。
- API Key 權限：行情／資料、帳務、正式環境；綁定 IP；**無交易權限**。
- 2026-11-18 換了新 API Key（加入證券帳戶授權）。換 Key 後要清 token 快取（pitfalls #7）。
- 使用正式環境（`SJ_PRODUCTION=true`）。
- GitHub repo：`pakeguo/sintrade`（private）。
