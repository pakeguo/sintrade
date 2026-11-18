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
  pages/
    page.ts          Page 介面：mount(el) / unmount()（離開頁面必須 releaseAll 退訂、清計時器）
    options.ts       期權頁（完成）
    overview.ts      總覽（藍圖，下一個實作）
    account.ts       帳務（藍圖）
    stocks.ts        個股（藍圖）
    blueprint.ts     藍圖頁產生器
  api.ts             LiveBackend：HTTP + SSE
  mock.ts            DemoBackend：假資料（?demo=1）
  bs.ts              Black-76
  types.ts           型別與 Backend 介面
  style.css          深色主題、紅漲綠跌、頁籤、手機版面
phone-server.mjs     手機唯讀轉接站（白名單：行情＋帳務查詢；封鎖 /order/*）
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
- 使用正式環境（`SJ_PRODUCTION=true`）。
- GitHub repo：`pakeguo/sintrade`（private）。
