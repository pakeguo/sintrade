# 期權看盤（個人版）

用永豐 **Shioaji** 的「自訂應用（Custom Apps）」架構打造的臺指選擇權看盤畫面：
本機 `shioaji server` 負責登入與行情（HTTP API + SSE），這個網頁 App 負責呈現。**前端完全不碰 API 金鑰。**

```
瀏覽器 ──▶ shioaji server (127.0.0.1:8080)
            ├─ /apps/mywatch/     這個 App
            ├─ /api/v1            商品檔、快照、K 棒
            └─ /api/v1/stream     SSE 即時行情
```

## 畫面上有什麼

**上方 8 張關鍵指標卡**（每張卡的 `?` 都有說明）

| 指標 | 意義 |
| --- | --- |
| 加權指數 | 漲跌、上漲／平盤／下跌家數 |
| 台指期 近月 | 漲跌與**基差**（正價差／逆價差） |
| 到期倒數 | 距最後交易時刻（13:30）還有多久 |
| 價平履約價 | 以**合成期貨**（K + C − P）判定，這才是該到期別真正的標的價 |
| **到期預期區間** | 價平跨式價格（C+P）＝市場定價的波動幅度，直接換算成指數區間 |
| 價平 IV | 選擇權貴或便宜；**偏斜**＝25Δ Put IV − 25Δ Call IV（避險需求） |
| P/C 成交量比 | 整條鏈的 Put 與 Call 成交量比，附紅綠比例條 |
| 量能壓力／支撐 | Call 最大量履約價（壓）／Put 最大量履約價（撐） |

**T 字報價**
- 自動以價平為中心，上下各 N 檔（可選 ±6～±18）。價平移動 3 檔以上才會重新置中，畫面不會一直跳動
- 成交量以長條**往兩側延伸**，最大量那檔會加亮，壓力和支撐一眼就看得出來
- 金色細帶標出「合成期貨」目前位置，淡金底色是「預期區間內」的履約價
- 每檔都即時算 IV 與 Delta（Black-76 模型，以合成期貨為標的）
- 價格變動時閃紅／綠

**右側明細**：點任何一個價格 → 1 分 K 走勢、五檔掛單、委買委賣比，以及 IV、Delta、內含價值、時間價值、損益兩平點

**快捷鍵**：`←` `→` 切換到期日　`C` 置中價平　`F` 看台指期

## 安裝與使用

需要：Python 3.10+、Node.js 18+、已簽署 API 的永豐帳戶。

### 1. 安裝 shioaji 並設定金鑰

```bash
uv tool install shioaji
```

（或 `pip install shioaji`）在任一資料夾建立 `.env`：

```
SJ_API_KEY=你的API_KEY
SJ_SEC_KEY=你的SECRET_KEY
SJ_PRODUCTION=false
```

`SJ_PRODUCTION=false` 是模擬環境，`true` 是正式環境。只看盤不下單也可以用正式環境，畫面右上角會標示目前是哪個環境。

### 2. 啟動 shioaji server（在 `.env` 所在資料夾）

```bash
shioaji server start
```

### 3. 部署這個 App 到 server（只需做一次，改版後再做一次）

```bash
npm install
```

```bash
npm run deploy
```

然後用瀏覽器開啟：**http://127.0.0.1:8080/apps/mywatch/**

### 開發／預覽模式

```bash
npm run dev
```

開啟 http://localhost:5173 （會自動把 `/api` 轉給 8080 的 server）。

不用 server 也能預覽介面：

```bash
npm run demo
```

或在網址加 `?demo=1`，會用隨機產生的假資料。連不到 server 時也會自動切換成 DEMO，並在頁面頂端顯示黃色提示。

## 用手機看（在家 Wi-Fi／出門在外）

shioaji server 只接受本機連線，所以多了一支「唯讀轉接站」`phone-server.mjs`：

```
手機 ──▶ 轉接站（電腦的 5180 埠，需密碼）──▶ shioaji server（127.0.0.1:8080）
```

- 只放行看盤與帳務查詢的 API；**下單、設定一律封鎖**，手機或網址外洩也不能被拿去下單
- 第一次要輸入密碼，之後 30 天免輸入；連續輸錯 5 次鎖 5 分鐘
- 不用安裝任何套件

### 第一次設定（在電腦上做一次）

1. 在 `G:\sintrade\.env` 最後加一行密碼（至少 6 個字元，不要跟其他帳號共用）：

   ```
   MW_PASSWORD=自己想一組密碼
   ```

2. 打包一次（如果剛 `npm run deploy` 過可略過）：`npm.cmd run build`
3. 啟動轉接站：`npm.cmd run phone`
4. 第一次啟動時 Windows 會跳出「防火牆」視窗，**勾選「私人網路」並按允許**
5. 視窗會列出網址，例如 `http://192.168.1.23:5180`。手機連同一個 Wi-Fi，用瀏覽器開這個網址、輸入密碼

### 出門在外（Tailscale）

1. 電腦安裝 Tailscale（https://tailscale.com/download ），用 Google 帳號登入
2. 手機（App Store／Google Play）安裝 Tailscale，**用同一個帳號**登入並打開連線
3. 重新執行 `npm.cmd run phone`，會多出一個 `http://100.x.x.x:5180（Tailscale）` 的網址
4. 手機用行動網路也能開這個網址。只有登入你 Tailscale 帳號的裝置連得到，不會公開在網路上

> 如果 Tailscale 網址打不開，到「Windows 安全性 → 防火牆與網路保護 → 允許應用程式通過防火牆」，把 Node.js 的「公用」也勾起來。

### 電腦也用轉接站開（自選清單電腦手機同步）

自選股群組存在電腦上的 `mywatch-store.json`。電腦請改用 **http://localhost:5180** 開啟（本機免密碼），
這樣電腦和手機看到的是同一份自選清單。用 `127.0.0.1:8080/apps/mywatch/` 開也能用，但自選清單只存在那個瀏覽器。

### 每天使用

電腦上要開著兩個視窗：`shioaji server start`（在 `G:\sintrade`）和 `npm.cmd run phone`。手機加入主畫面（Safari 分享 →「加入主畫面」）會更像 App。

## 疑難排解

- **畫面只有白底文字、沒有顏色、時鐘停在 `--:--:--`**：代表 JS/CSS 沒載入。請 `git pull` 取得最新版，再重新執行 `npm run deploy`（現在會打包成單一 `index.html`，沒有子目錄路徑問題），然後在瀏覽器按 `Ctrl+F5` 強制重新整理。
- **`'shioaji' 不是內部或外部命令`**：不影響部署，`npm run deploy` 直接用 Windows 內建的 `curl` 呼叫 server 的上傳 API，只要 server 有在執行就好。要刪除已上傳的 App 用 `npm run undeploy`。
- **右上角一直顯示 DEMO**：前端連不到 `/api/v1/info`，確認 `shioaji server start` 有在執行。
- 其他問題：按 `F12` → Console 分頁，把紅色錯誤訊息截圖。

## 注意事項

- **未平倉量**：Shioaji 的 API 沒有提供選擇權未平倉量（OI），所以壓力／支撐是以**今日成交量**代替，Max Pain 也因此無法計算。
- **IV 用的價格**：買賣價差合理時用五檔中價，否則用最近成交價。深價外、久未成交的合約 IV 可能失真或顯示 `—`。
- **訂閱數量**：每檔履約價訂閱 Call/Put 的 Tick + BidAsk，±10 檔約 84 個訂閱，±18 檔約 150 個。
- 試撮（simtrade）資料不列入計算。
- 這是純看盤工具，沒有任何下單功能。
- 本程式非永豐官方產品，數據僅供參考，不構成投資建議。

## 檔案結構

四大頁面（總覽／個股／期權／帳務）共用一個「行情中心」。詳細架構與開發規則見 `docs/ai/README.md`。

```
src/
  main.ts       App 外框：頁籤、全域報價列、連線狀態
  core/         行情中心（連線、報價、訂閱管理、台指期換月）與共用工具
  pages/        各頁面（期權已完成；總覽、帳務、個股目前顯示設計藍圖）
  api.ts        shioaji server 的 HTTP / SSE 串接
  mock.ts       DEMO 假資料
  bs.ts         Black-76 定價、隱含波動率、Delta
docs/ai/        給 AI 讀的專案紀錄：踩坑、決策、需求、API 筆記
```
