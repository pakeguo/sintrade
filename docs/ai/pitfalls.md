# 踩過的坑（根因與解法）

每一條都是實際發生過的問題。修改相關程式前務必先讀。

---

## 1. 台指期結算後仍顯示舊月份報價 ⚠️ 重要

**現象**（2026-11-18）：11 月台指期當天 13:30 結算，15:00 夜盤開盤後畫面仍顯示 11 月合約，應該是 12 月。

**根因**
- 原本啟動時只呼叫一次 `GET /data/contracts/TXFR1` 取得「近月連續合約」的 `target_code`，之後一直沿用。
- shioaji server 每天只在 **08:12～08:30 例行維護**時更新商品檔，所以結算後（13:30）到隔天早上之間，`TXFR1` 仍可能指向已到期月份；就算重新整理網頁也一樣。

**解法**（`src/main.ts`：`isLive` / `pickFuture` / `setFuture` / `rollCheck`）
- 不依賴 `TXFR1`。改用 `GET /data/contracts/futures?root=TXF` 列出各月份實際合約（排除 `R1`/`R2`），
  自行挑「尚未到期且最近」的一個。
- 「到期」定義：`delivery_date` 當天 **13:30（台北）之後**即視為到期。
- 每 60 秒 `rollCheck()`：近月代碼改變就退訂舊月份、訂閱新月份、重新載入快照與參考價，若右側明細正在看期貨也一併切換。
- 選擇權到期日用同一個 `isLive()`，過 13:30 自動從到期日列表移除並切換。
- 只有在拿不到清單時才退回 `TXFR1`。

**通則**：凡是「連續月」「近月」這類會隨時間改變對應的代碼，都不能只在啟動時解析一次。
個股期貨（如 `CDFR1`）、小台（`MXFR1`）將來也要套用同一套換月邏輯。

**驗證方式**：DEMO 模式 + Playwright `page.clock.install({ time: '2026-11-18T05:28:00Z' })`，
`runFor(3 分鐘)` 後確認卡片從「台指期 11月」變成「台指期 12月」。

---

## 2. 連續月代碼：快照與即時行情的代碼不一致

- `POST /data/snapshots` 對 `TXFR1` 回傳 `code: "TXFR1"`，但 SSE `tick_fop` 回報的是實際月份代碼（如 `TXFL6`）。
- 若用不同 key 存，參考價會遺失（畫面漲跌顯示「—」）。
- 解法：`loadSnapshots()` 把連續月與實際代碼統一存到 `futKey`；另以 `contractInfo().reference` 補參考價。

---

## 3. 部署後畫面只有白底文字（JS/CSS 404）

- 根因：Vite 預設輸出 `assets/` 子目錄，上傳到 shioaji server 後子路徑對不上（Windows 反斜線等）。
- 解法：`vite-plugin-singlefile` 打包成**單一 `index.html`**，`base: './'`。不要改回多檔輸出。

---

## 4. `'shioaji' 不是內部或外部命令`

- 根因：`uv tool install` 裝在 `%USERPROFILE%\.local\bin`，未加入 PATH。
- 解法：已加入使用者 PATH。部署不依賴 CLI：`npm run deploy` 用 `curl` 呼叫 `POST /api/v1/apps/mywatch`。
- 找 server 實際位置：`Get-NetTCPConnection -LocalPort 8080 -State Listen` + `Get-CimInstance Win32_Process`。

## 5. PowerShell 擋 `npm`（npm.ps1 無法載入）

- 根因：Windows 執行原則。解法：指令一律寫 `npm.cmd run …`。

## 6. server 啟動失敗 `os error 10048`

- 根因：舊 server 殘留佔用 8080，`shioaji server stop` 卻說沒在跑。
- 解法：`Get-NetTCPConnection -LocalPort 8080 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`。

## 7. 商品檔 500 `NotReady` / `SessionNotEstablished`

- 表象：`GET /data/contracts/*` 回 500 `transient transport failure … NotReady`。
- 實際根因：log 有 `Received 401, proactively disconnecting Solace session`、
  `Token doesn't have permission`——**舊的 token 快取**（`%USERPROFILE%\.shioaji\token_pool`）與目前 API Key／環境不符。
- 解法：停 server → 把 `token_pool` 改名 → 重啟，log 應出現 `performing new login` 與 `Loaded … contracts`。
- 前端已加：遇 500/NotReady 自動重試並顯示說明（`retry()`）。
- 查 log：`Get-Content "$env:USERPROFILE\.shioaji\logs\server-8080\server.*.log" -Tail 2000 | Select-String …`

**換 API Key 時一定要做**：停 server → 改名 `token_pool` → 重啟。否則 server 會沿用舊 Key 的 token，又出現 401／NotReady。

## 7a. 共用服務最後一個使用者離開時，要清掉「已訂閱」紀錄

- `account.unuse()` 會 `hub.releaseAll('account')` 退訂，但 `mapped`／`stkSubs` 還記著「已訂閱」，
  回到頁面時就不會重新訂閱 → 損益不再跳動。解法：unuse 時一併 `clear()`。
- 寫新的共用服務（use/unuse）時照同一模式。

## 8. IV 與 e-Leader 不同（不是 bug）

- 價格已與 e-Leader 比對一致。差異來自算法：
  - e-Leader 以**加權指數**為標的（夜盤時是過時的收盤價）→ Call/Put IV 分歧（38% vs 60%）。
  - 本專案以**合成期貨** `K + C − P` 為標的、剩餘時間以**實際小時**計 → Call/Put IV 一致，近到期時數值較高。
- 「到期預期區間」（價平跨式）不受 IV 算法影響，是最可靠的指標。

## 9. 夜盤「基差」是誤導

- 夜盤時現貨已收盤，期貨 − 指數 其實是夜盤漲跌。日盤才顯示「基差」，夜盤改顯示「較現貨收盤」。

## 10. 手機轉接站白名單繞過

- `../`、`%2e%2e`、`//` 可繞過正則白名單 → 路徑只允許 `[A-Za-z0-9_\-/.]` 且不得含 `..` 或 `//`。

## 11a. 用正則批次改名會誤傷字串

- 架構重整時用 `\bidx\b → hub.idx` 批次替換，把 DOM id `'c-idx'` 也改成 `'c-hub.idx'`，期權頁卡在「載入中」。
- 之後批次替換要排除引號內字串，替換完 `grep "'[^']*hub\."` 檢查。

## 11. 窄螢幕時報價表被壓扁

- 根因：`main { flex: 1; min-height: 0 }` 在單欄時把高度鎖在一個畫面內。
- 解法：`max-width: 1000px` 時 `main { flex: none }`、改為整頁捲動。
