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
    bars.ts          K 棒週期：1/3/5/15/30/自訂分（以 09:00 起每 N 分、結束時間標記）、日／週／月；applyTick() 即時更新最後一根
    ta.ts            技術指標庫（主圖 7：MA/EMA/BOLL/ENV/SAR/一目/均價；副圖 18：VOL/MACD/KD/RSI/DMI/OBV/CCI/WR/BIAS/PSY/ATR/MTM/ROC/TRIX/DMA/MFI/ARBR/VR/CMO）
    catalog.ts       股票目錄：代碼→名稱／產業／交易所。stockList()＋逐檔 contractInfo 背景建立，localStorage `mw.catalog` 快取 7 天；search()、industries()、byIndustry()
    nav.ts           openTA()：點商品要去哪（之後換成技術分析窗口）
    store.ts         使用者設定（自選群組、大單門檻）：經 phone-server 開啟時存 mywatch-store.json（電腦手機同步），否則 localStorage
    indicators.ts    toDaily/regroup、SMA、布林、RSI、VWAP、分價量表
    account.ts       帳務服務：15 秒查詢 margin/position_unit/profit_loss/settlements；
                     期權部位代碼（TXO20261228000C）對應實際合約後即時計算損益；證券庫存用即時 tick
  pages/
    page.ts          Page 介面：mount(el) / unmount()（離開頁面必須 releaseAll 退訂、清計時器）
    options.ts       期權頁（完成）
    products.ts      報價（原「商品」，id 仍為 products）：報價小卡（庫存／微台近次月／自訂頁籤）＋精簡 T 字報價
    overview.ts      總覽（完成）：大盤｜台指期｜期權摘要、走勢疊圖、權值股前 10、類股熱力圖、帳戶三區
    account.ts       帳務（完成）：權益風險、組合 Greeks、期權部位、到期損益圖（SVG）、證券庫存、自選期間已實現損益
    stocks.ts        分析（原「個股」，id 仍為 stocks，網址 #/stocks/<代碼>）：個股／期貨／選擇權共用。
                     左：自選群組（拖曳、同步）；選單內建「期權（預設）」群組＝台指期、微台近月＋最近週選／月選點開選履約價
                     右：盤中（分時+VWAP、疊加線、五檔、內外盤、大單四級、逐筆；期貨／選擇權有日盤／全時）、
                     K線（1/3/5/15/30/自訂分、日週月、MA、布林、RSI、分價量表）、技術分析（ui/taview.ts）
    blueprint.ts     藍圖頁產生器
  ui/
    （core/session.ts：交易時段工具——交易日歸屬、期貨 N 分 K 起點；core/nav.ts：openTA() 跳分析頁、derivName() 期權簡稱）
    taview.ts        技術分析畫面：1 主（K＋量＋疊加）2 副，指標與參數存 localStorage `mw.taCfg`
    picker.ts        報價頁搜尋列（代碼／名稱）＋「選股」視窗（類股、成交量前 50、成交值前 50），加入到自選群組
    tchain.ts        精簡 T 字報價元件（結算日小卡、指標列、價平 ±N 檔）
    heatmap.ts       類股熱力圖 Canvas 渲染器（squarify 版面、緩動、粒子、光暈、tooltip；隱藏分頁自動暫停）
  api.ts             LiveBackend：HTTP + SSE
  mock.ts            DemoBackend：假資料（?demo=1）
  bs.ts              Black-76
  types.ts           型別與 Backend 介面
  style.css          深色主題、紅漲綠跌、頁籤、手機版面
phone-server.mjs     轉接站：（白名單：行情＋帳務查詢；封鎖 /order/*）；/mw/store 設定同步；本機 127.0.0.1 免密碼
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
- 螢幕 1920×1080，Chrome 有書籤列，網頁可視範圍約 **1920×912**：版面以此為準測試（Playwright viewport 1920×912）。
- GitHub repo：`pakeguo/sintrade`（private）。
