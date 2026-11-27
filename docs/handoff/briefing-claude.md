# 給「投資資訊簡報」Claude 的說明：如何從使用者的看盤軟體取得資料

> 這份文件由使用者的看盤軟體專案（sintrade）整理，請你讀完後判斷能否取得資料，並回報使用者。
> 使用者以**繁體中文**溝通，電腦是 **Windows 11**（指令請用 PowerShell 可用的寫法）。

---

## 1. 這套軟體是什麼

- 使用者的個人看盤軟體，資料來源是**永豐金 Shioaji**。
- 資料由使用者電腦上的 **shioaji server**（永豐官方程式）提供，只在本機 `http://127.0.0.1:8080` 上開放。
- 另有一個**唯讀轉接站** `http://127.0.0.1:5180`（`npm.cmd run phone` 啟動），只開放看盤與帳務查詢，**下單一律封鎖**。
  - 也提供使用者的自訂功能：**三大法人買賣超**（代抓證交所、櫃買資料）。

## 2. 先判斷：你能不能連到

| 你的執行環境 | 能否直接取得 | 說明 |
| --- | --- | --- |
| claude.ai 網頁／App 對話、雲端排程 | **不能** | 你在雲端，連不到使用者電腦的 `127.0.0.1`。請改用下方「替代做法」。 |
| 在使用者 **Windows 電腦上**執行的 Claude（Claude Code、Cowork、桌面版本機存取） | **能** | 用 PowerShell 呼叫下面的網址即可。 |
| 透過 Tailscale 連到使用者電腦 | 理論上可以 | 轉接站要設 `MW_PASSWORD` 才對外開放並需登入；使用者目前**暫緩**手機／外部連線，**不要**主動要求開放。 |

**替代做法（雲端對話）**：請使用者在電腦上執行第 4 節的指令，把輸出貼給你；或請使用者改在本機的 Claude 執行簡報。

## 3. 安全規則（務必遵守）

1. **只讀資料，絕對不下單**。不得呼叫任何 `/api/v1/order/*`、`place_order`、`cancel_order`、`update_price`、`update_qty`、成交回報訂閱。
2. **一律走轉接站 `127.0.0.1:5180`**，不要直接打 `8080`：轉接站有白名單，會擋掉下單；8080 沒有這層保護。
3. 不要讀取或輸出專案的 `.env`（含 API 金鑰），也不要把帳戶號碼、持股明細貼到對外服務。
4. 帳務資料（庫存、損益）屬於私人資訊，只在使用者要求時放進簡報。

## 4. 可用的資料與指令（PowerShell，需轉接站在執行中）

> 確認轉接站有沒有在跑：`Get-NetTCPConnection -LocalPort 5180 -State Listen`；沒有輸出就請使用者在專案資料夾執行 `npm.cmd run phone`。
> 以下統一用 `Invoke-RestMethod`（PowerShell 內建），JSON 用單引號包起來即可，不必跳脫。

### 4.1 指數與期貨快照（加權、櫃買、台指期）

```powershell
$B = 'http://127.0.0.1:5180/api/v1'
Invoke-RestMethod -Method Post -Uri "$B/data/snapshots" -ContentType 'application/json' -Body '{"contracts":[{"security_type":"IND","exchange":"TSE","code":"IX0001"},{"security_type":"IND","exchange":"OTC","code":"IX0043"}]}'
```

- 回傳每筆：`code, open, high, low, close, change_price, total_volume, total_amount, buy_price, sell_price, volume_ratio, yesterday_volume`。
- 漲跌幅＝`change_price / (close - change_price)`。

台指期**近月**（不要用 `TXFR1`，換月後可能仍指向已到期合約）：

```powershell
$f = Invoke-RestMethod "$B/data/contracts/futures?root=TXF&region=TW"
# 取尚未到期、delivery_date 最早的一筆（結算日 13:30 後視為到期；日期可能是 2026/12/16 或 2026-12-16 格式）
```

再把該合約的 `code`（例：`TXFL6`）放進 snapshots：`{"security_type":"FUT","exchange":"TAIFEX","code":"TXFL6"}`。小台 `MXF`、微台 `TMF` 同理。

### 4.2 個股快照

```powershell
Invoke-RestMethod -Method Post -Uri "$B/data/snapshots" -ContentType 'application/json' -Body '{"contracts":[{"security_type":"STK","exchange":"TSE","code":"2330"},{"security_type":"STK","exchange":"TSE","code":"2317"}]}'
```

- 上櫃股票 `exchange` 用 `OTC`。一次最多約 500 檔。
- 名稱：`GET $B/data/contracts/2330/info?region=TW&security_type=STK` → `name, reference, limit_up, limit_down`。

### 4.3 成交量／成交值排行（盤中）

```powershell
Invoke-RestMethod -Method Post -Uri "$B/data/scanner" -ContentType 'application/json' -Body '{"scanner_type":"AmountRank","ascending":true,"count":20}'
```

- `scanner_type`：`VolumeRank`（成交量）、`AmountRank`（成交值）、`ChangePercentRank`（漲跌幅）、`DayRangeRank`、`TickCountRank`。
- **注意：`ascending:true` 才是由大到小**（永豐的設計）。
- **收盤後排行常常是空的**：此時改用個股快照自行排序（`total_volume`、`total_amount`）。

### 4.4 三大法人買賣超（盤後，約 16:00 後公布）

```powershell
Invoke-RestMethod 'http://127.0.0.1:5180/mw/inst'
```

- 回傳 `{ date: 'YYYY-MM-DD', rows: [{ code, name, mkt: 'TSE'|'OTC', foreign, trust, dealer }] }`，**單位是股**（÷1000＝張）。
- 當天還沒公布會自動回最近一個有資料的交易日，請以 `date` 為準並在簡報註明。
- 外資買超前 10 範例：`(Invoke-RestMethod 'http://127.0.0.1:5180/mw/inst').rows | Where-Object { $_.code -notlike '00*' } | Sort-Object foreign -Descending | Select-Object -First 10`

### 4.5 K 線（歷史）

```powershell
Invoke-RestMethod -Method Post -Uri "$B/data/kbars" -ContentType 'application/json' -Body '{"contract":{"security_type":"IND","exchange":"TSE","code":"IX0001"},"start":"2026-11-20","end":"2026-11-27"}'
```

- **只有 1 分 K**，欄式格式：`{ datetime[], Open[], High[], Low[], Close[], Volume[], Amount[] }`，每根以**結束時間**標記（台北時間）。
- 日K請自行彙整；**範圍不要抓太大**（1 分 K 一天約 270 根，期貨日夜盤約 1,140 根），簡報用最近幾天即可。

### 4.6 臺指選擇權

- 到期清單：`GET $B/data/contracts/options/roots?region=TW`（月選 `TXO`，週選如 `TX1`–`TX5`、`TXU` 等）。
- 合約清單：`GET $B/data/contracts/options?root=TXO&region=TW` → 含 `strike_price`、`option_right`、`delivery_date`。
- 報價用 snapshots（`security_type: "OPT"`, `exchange: "TAIFEX"`），一次別超過 500 檔；只取價平附近的履約價即可。

### 4.7 帳務（私人資訊，使用者要求時才用）

```powershell
$acc = Invoke-RestMethod "$B/auth/accounts"           # 帳戶清單：account_type S=證券、F=期貨
$s = $acc | Where-Object account_type -eq 'S' | Select-Object -First 1
$body = @{ account_type=$s.account_type; broker_id=$s.broker_id; account_id=$s.account_id } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$B/portfolio/position_unit" -ContentType 'application/json' -Body $body
```

- 可用：`position_unit`（庫存）、`profit_loss`（已實現，body 加 `begin_date`、`end_date`）、`margin`（期貨權益，用 F 帳戶）、`settlements`（交割款）。
- **日期格式不一致**：期貨帳戶可能回 `20261118`、證券帳戶回 `2026-11-18`，彙整前請統一。

## 5. 簡報常用時間與注意事項

- 台股現股 09:00–13:30；台指期日盤 08:45–13:45、夜盤 15:00–隔日 05:00。
- 加權指數即時資料只有日盤；夜盤時段請改看台指期。
- shioaji server 每天 08:12–08:30 例行維護，此時可能查不到資料。
- server 回 500 `NotReady` 代表尚未就緒，稍後重試；連不上 5180／8080 代表程式沒開，請使用者啟動，不要自行嘗試修復。

## 6. 建議的快速簡報內容（可直接套用）

1. 大盤：加權、櫃買漲跌與成交值（4.1）
2. 台指期近月：價位、漲跌、與加權的價差（4.1）
3. 成交值前 10（4.3，收盤後用快照排序）
4. 外資／投信買超、賣超前 5（4.4，註明資料日期）
5. （使用者要求時）持股今日表現（4.7＋4.2）

## 7. 請你回報使用者的事

- 你目前的執行環境能不能連到 `127.0.0.1:5180`（實際試一次 `Invoke-RestMethod 'http://127.0.0.1:5180/mw/inst'` 的結果）。
- 若不能，你建議採用哪種替代做法（使用者貼資料／改由本機 Claude 執行）。
