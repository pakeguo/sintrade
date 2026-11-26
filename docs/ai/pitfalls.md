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

## 7b. 圖表在隱藏區塊建立後切換顯示，K 棒擠成一團

- lightweight-charts `autoSize` 靠 ResizeObserver，切成顯示的當下寬度還是 0；
  此時 `setVisibleLogicalRange` 會算出極小的 barSpacing。
- 解法：兩次 `requestAnimationFrame` 後先 `chart.resize()` 再設定範圍（`stocks.ts` 的 `loadK`）。

## 7c. 類股串流盤後不推送 → 熱力圖空白

- `index_components` 是即時串流，盤後很可能不再推送；一打開總覽就沒有資料。
- 解法：盤中每 10 秒把類股值存到 localStorage `mw.sectorsClose`（含資料時間），盤後沒有即時資料時顯示「收盤 MM/DD HH:MM」。
- 限制：當天盤中完全沒開過總覽就沒有收盤值（顯示說明文字）。

## 7d. CSS 的 display 會蓋掉 HTML 的 hidden 屬性

- `.heat-empty { display: flex }` 讓 `hidden` 失效，「載入中」一直壓在熱力圖上。
- 有設定 display 的元素若要用 `hidden`，要補 `.xxx[hidden] { display: none; }`。
- 2026-11-26 又犯一次：熱力圖提示框 `.hm-tip { display: flex }` → 滑鼠移出後提示框不消失、擋住熱力圖。
  **新增任何有 display 的元素並用 hidden 控制時，順手補 `[hidden]` 規則。**
- 同次也踩到：共用 class 設 `position: relative` 把原本 `position: absolute` 的容器蓋掉，畫布高度只剩一半。

## 7e. 全域 CSS 規則誤傷其他頁的同類元件

- 期權頁手機版用 `.chain thead tr:nth-child(2) th:nth-child(2)` 隱藏 IV 欄，結果商品頁的精簡 T 字報價（也用 `.chain`）表頭被藏錯欄。
- 頁面專屬規則要加 `.page-<id>` 前綴（`main.ts` 會把頁面容器設成 `page page-<id>`）。

## 7f. 模組層級變數只在載入時讀一次 localStorage

- 個股頁的 `mode` 在 import 時讀 `LS.get('stkMode')`，之後 `openTA()` 改了 LS 也不會生效。
- 會被其他頁面改動的設定，要在 `mount()` 時重新讀取。

## 12. 實盤時按鈕點了沒反應（畫面會動）⚠️ 重要

**現象**（2026-11-26）：接上真實行情後，畫面持續更新，但點任何按鈕、報價、小卡都沒反應。DEMO 測試時看不出來。

**根因**：各頁 `frame()` 每 0.2–0.5 秒用 `innerHTML` 重繪；真實行情幾乎每次都 dirty。
真人點擊「按下→放開」約 0.1–0.2 秒，期間按鈕被換成新元素，瀏覽器就不會觸發 `click`。
DEMO 更新慢、Playwright 的 `click()` 瞬間完成，所以測試沒抓到。

**解法**：`core/util.ts` 的 `pointerHeld()`：pointerdown 時設為 true、pointerup 後（setTimeout 0，讓 click 先跑完）恢復。
所有 `frame()` 在 `pointerHeld()` 時先不重繪。新增頁面或元件的重繪迴圈**一定要加這個判斷**。
另外 `main.ts` 的 `route()` 把 `unmount()` 包在 try/catch，避免舊頁出錯卡住頁籤。

**測試方式**：Playwright 用 `mouse.down()` → 等 150ms → `mouse.up()` 模擬真人點擊（腳本範例見對話紀錄 click.cjs），不要只用 `click()`。

## 13. 實盤熱力圖一直「載入中」：官方類股權重串流收不到 ⚠️

**現象**（2026-11-26）：DEMO 正常，實盤熱力圖空白顯示「載入中」。

**根因**（由診斷列確認）：`group_metric/weight` 訂閱成功但**從未推送**（0 筆），其餘
`contribution`、`weighted_performance`、`amount` 有收到；而 `sectorList()` 會排除沒有權重的類股 → 0 個類股。
另外實盤 group_metric 推送頻率遠低於文件寫的「每秒一次」（幾分鐘只有 2 筆）。

**解法**（`core/components.ts` 的 `deriveWeights()`）：
- 權重（%）＝ 貢獻點數 × 10⁴ ÷（加權指數參考價 × 加權漲跌幅%）；|漲跌幅| < 0.15% 時誤差大，沿用上次值。
- 以 0.7/0.3 平滑並存在 localStorage `mw.sectorWeights`；有官方權重時優先使用官方值。
- DEMO 用 `&noweight=1` 模擬「收不到權重」。
- 畫面上的診斷列已於 2026-11-26 使用者確認後移除；`components.diag` 計數與 Console 的 `[類股串流] 第一筆` 仍保留，需要時可在 Console 輸入檢查。

**通則**：shioaji 加值串流的某些 metric 可能實盤不推送或頻率很低，不要讓整個元件依賴單一 metric。

## 14. lightweight-charts 固定時間軸（09:00–13:30）的兩個陷阱

- 想用空白點（whitespace）撐出完整交易時段：**`visible: false` 的序列不會被算進時間軸** → 改用「看得見但完全透明」的線。
- **`fixRightEdge: true` 會把右邊界綁在最後一筆「實際資料」**，後面的空白時段看不到 → 不用 fixRightEdge，
  改在 rAF 後 `setVisibleLogicalRange({ from: -6, to: 276 })`（第 0 點＝09:00、第 270 點＝13:30，兩端留邊距避免標籤被切）。
- 實作見 `stocks.ts` 的 `setIntraday()`／`fitSession()`；之後其他分時圖（總覽走勢、技術分析窗口）照同樣做法。
- 圖表在隱藏狀態（如個股頁 K 線模式）時寬度為 0；切回顯示要重新設定範圍 → 用 ResizeObserver 偵測寬度變化就呼叫 `fitSession()`。
- 要「以參考價為中心上下對稱」：除了 autoscaleInfoProvider，還要把 `rightPriceScale.scaleMargins` 設成上下相等（預設上 0.2／下 0.1 會讓參考價偏下）。
- 總覽走勢圖（2026-11-26）已套用：日盤 08:46–13:45（300 點）、全時＝前一交易日 15:01→隔日 05:00 ＋ 當日 08:46–13:45（1,140 點，休市時段不留白）。
  交易日判定 `sessionDay()`：15:00 後算下一個平日、週六凌晨算下週一（`overview.ts`）。
  舊做法「取加權最後交易日的期貨所有 K 棒」會把凌晨夜盤畫進日盤，時間軸出現 00:30–04:30。

## 15. 讓長清單不撐高 grid 列：用絕對定位，不要用 flex:1 + height:0

- 個股盤中三欄要上下切齊、逐筆清單在框內捲動。用 `.ticks { flex:1; height:0 }` 實測無效：
  grid 計算列高時仍把清單內容算進去，整列被撐到 3000px。
- 解法：卡片 `position: relative`，清單 `position: absolute; top/bottom/left/right` 鋪在卡內 → 列高只由走勢圖決定。
  中間欄最後一張卡 `flex: 1` 往下填滿。窄螢幕（≤1400px）清單移到下方時改回一般定位。
- 驗證：Playwright 量 `.lv-chart`、`.lv-side .card:last-child`、`.lv-ticks` 的 top/bottom 是否相等。
- lightweight-charts `autoSize` 的圖表放在 flex:1 容器裡也會互相撐高（容器依畫布長、畫布依容器長）→
  一律包一層 `position: relative` 外框＋`position: absolute; inset: 0` 內層（`.fc-in`）再建立圖表。

## 16. CSS class 撞名：個股頁的 `.live` 把總覽熱力圖撐爆 ⚠️

**現象**（2026-11-26）：調整個股頁高度後，總覽「不能點擊、大小比例失調」，熱力圖被推到畫面外。
**根因**：個股盤中容器用了通用 class `.live`，而總覽熱力圖的「● 即時」標籤即時時也加 `live` class（連線狀態 `.conn.live` 也是）。
新增 `.live { height: calc(100vh - 208px) }` 後，這個小標籤被撐成 700px 高。之前 `.live { display:grid }` 就已經套上去了，只是沒有明顯症狀。
**解法**：改名 `.stk-live`。**規則：頁面專屬元素用「頁面前綴」命名（`stk-`、`ov-`、`pd-`、`ac-`），不要用 live/active/on 這類通用字當主要 class。**
- 2026-11-27 又一例：期權頁「量能壓力／支撐」用 `.wl`，與個股自選清單 `.wl` 撞名 → 8 張指標卡被撐到 210px。改名 `.op-wall`，自選清單規則限定 `.stk .wl`。
**防範**：改 CSS 後一定要跑 `tests/ui/layout.cjs` 與 `tests/ui/clicks.cjs`（涵蓋所有頁面），不能只測改的那一頁。

## 17. 帳務頁整頁點不動：借用別頁的 class，被「鋪滿」規則放大成全螢幕覆蓋層 ⚠️

**現象**（2026-11-26）：使用者沒有期權部位時，帳務頁所有按鈕、頁籤都點不動；Console 顯示點擊目標全是 `DIV.muted.heat-empty`。
**根因**：帳務頁「到期損益圖」的空狀態文字借用了總覽熱力圖的 class `heat-empty`。修熱力圖時把 `.heat-empty` 設成
`position:absolute; inset:0`，而 `.payoff` 沒有定位 → 包含區塊變成整個視窗 → 透明文字層蓋滿全畫面。
DEMO 預設有期權部位，所以測試沒觸發。
**解法**：帳務頁改用自己的 `ac-empty`；`.heat-empty` 規則限定在 `.heat .heat-empty`；`.payoff` 加 `position:relative`；
純顯示的提示層加 `pointer-events:none`。DEMO 加 `&nopos=1`（沒有期權部位），`tests/ui/clicks.cjs` 涵蓋此情境。
**規則**：
- 不要跨頁借用 class（pitfalls #16 的延伸）；`position:absolute; inset:0` 的規則一律寫成「父層 子層」限定範圍。
- 測試要包含「空資料」情境（沒有部位、沒有庫存、商品檔尚未載入）。
- 問題偵測器 `core/diag.ts`：錯誤、長任務、點擊被大面積覆蓋層攔截 → 畫面底部紅色提示列。

## 18. 證交所網站擋雲端機房 IP；Node fetch 不走 HTTPS_PROXY

- `www.twse.com.tw` 從雲端開發環境回「因為安全性考量…」或 HTTP 307 → 無法在雲端驗證 TWT49U 格式（櫃買 `www.tpex.org.tw` 可以）。
  使用者家中電腦（台灣家用網路）預期可用；欄位依名稱解析（日期／代號／前收盤／參考價），兩邊格式差異不影響。
- 雲端測試 phone-server 時 Node 內建 fetch 不吃代理 → 用 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node phone-server.mjs`。
- `openapi.twse.com.tw` 只有預告表（TWT48U_ALL），沒有歷史除權息，不能拿來還原。

## 19. 期貨全時時間軸：窄圖被截斷、Math.min(...陣列) 爆堆疊

- **症狀 1**：分析頁「累計淨買」小圖切到「全時」後，時間軸仍只顯示 09:00–12:00 一小段。
  **根因**：lightweight-charts 預設 `timeScale.minBarSpacing = 0.5px`；全時時間軸有 1,140 點（15:01→05:00＋08:46→13:45），
  小圖寬約 270px，`setVisibleLogicalRange` 被夾成最多約 540 點。**解法**：固定時間軸的圖都設 `minBarSpacing: 0.05`（分析頁兩張圖、總覽走勢圖）。
- **症狀 2**：期貨／選擇權切到 K 線時 `RangeError: Maximum call stack size exceeded`（`volumeProfile`）。
  **根因**：`Math.min(...bars.map(...))` 展開數十萬根 1 分 K（期貨一天約 1,140 根 × 200 天）超過參數上限。
  **解法**：大陣列一律用迴圈求極值，不用展開運算子。
- 期貨 N 分 K／日K 規則在 `core/session.ts`：日盤以 08:45、夜盤以 15:00 起算；日K＝全盤日K（夜盤歸下一交易日）。

## 20. 分批補 K 棒的坑

- **畫面卡住**：DEMO 的 kbars 立即 resolve，往前補的迴圈全在同一個長任務裡跑（問題偵測器報「畫面卡住 2781 ms」）。每批之間 `await setTimeout(0)` 讓出主執行緒。
- **技術分析停在舊的位置**：先用第一批（只有十幾根）設定可視範圍，之後 `setData` 往前補，邏輯索引位移 → 畫面跑到幾個月前。
  使用者還沒拖曳／縮放（`pointerdown`、`wheel`）前，每補一批就重新對齊到最近的 K 棒。
- **日K跨批次**：期貨夜盤屬於下一交易日，兩批 1 分 K 的邊界會把同一根日K切成兩半 → 往前補時若新批的最後一根與既有第一根同一天要合併；往後補時從快取日前幾天重抓、只取代 `to` 之後的日K。
- 補資料時合併只接受**更早**的 K 棒（`mergeOlder`），最近的 K 棒保留即時成交更新。

## 21. 證交所／櫃買資料：瀏覽器抓不到、頁面網址不同

- `www.twse.com.tw/rwd/zh/fund/T86`、`www.tpex.org.tw/www/zh-tw/insti/dailyTrade` 都**沒有 Access-Control-Allow-Origin** → 前端直接 fetch 一定失敗，要由轉接站代抓。
- 使用者平常從 shioaji server（`127.0.0.1:8080/apps/mywatch/`）開啟，同網域的 `/mw/*` 不存在 → 前端先試 `/mw/inst`，再試 `http://localhost:5180/mw/inst`（轉接站回 CORS 標頭給本機來源）。還原日K當初就是只走同網域才「接不上」。
- T86 欄位：外資＝`[4]`（外陸資不含自營）＋`[7]`（外資自營商）、投信＝`[10]`、自營商＝`[11]`；櫃買：外資合計＝`[10]`、投信＝`[13]`、自營商合計＝`[22]`。單位都是「股」。
- 假日或當天尚未公布：T86 `stat` 不是 `OK` → 往前找最多 10 天，每次間隔 0.4 秒（證交所有頻率限制）。

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
