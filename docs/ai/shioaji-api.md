# shioaji server API 筆記

來源：官方文件原始碼 `github.com/Sinotrade/Sinotrade.github.io`（`zh/tutor/**/index.md`、`llms-full.txt`）
與官方範例 `github.com/Sinotrade/shioaji-pro-app`。
（sinotrade.github.io 網站在雲端開發環境被網路政策擋住，改讀 GitHub 原始碼。）
本機 OpenAPI 文件：`http://127.0.0.1:8080/docs`。

## 合約 `{security_type, exchange, code, target_code?}`

- `security_type`：STK / FUT / OPT / IND / WRT；`exchange`：TSE / OTC / OES / TAIFEX

## 已使用

| 方法 | 路徑 | 備註 |
| --- | --- | --- |
| GET | `/info` | `simulation` 欄位判斷環境 |
| GET | `/data/contracts/{code}?security_type=&region=TW` | 合約基本資料；`TXFR1` 會帶 `target_code` |
| GET | `/data/contracts/{code}/info` | 名稱、`reference`、`limit_up/down` |
| GET | `/data/contracts?security_type=STK&region=TW` | 不帶 page/page_size 一次回傳全部；只有代碼與交易所（無名稱）。server log 顯示 STK 約 4 萬筆（含非一般股票）→ 前端只取 4 碼與 00 開頭 ETF |
| GET | `/data/contracts/futures?root=TXF` | 各月份合約，含 `delivery_date`（可能是 `2026/06/17` 格式）|
| GET | `/data/contracts/options/roots` | `[{root,name}]`；臺指週選 root 如 TX1–TX5、TXU… |
| GET | `/data/contracts/options?root=TXO` | `strike_price`、`option_right`、`delivery_date` |
| POST | `/data/snapshots` | `{contracts:[…]}`，一次最多約 500 |
| POST | `/data/kbars` | `{contract, start, end}` → 欄式 `{datetime[],Open[],High[],Low[],Close[],Volume[],Amount[]}`；1 分 K 以**結束時間**標記 |
| POST | `/data/ticks` | `query_type`: AllDay / RangeTime / LastCount |
| POST | `/data/scanner` | `scanner_type`: ChangePercentRank / ChangePriceRank / DayRangeRank / VolumeRank / AmountRank / TickCountRank；`ascending:true` = 由大到小 |
| POST | `/stream/subscribe`、`/stream/unsubscribe` | `{...contract, quote_type: Tick/BidAsk/Quote, intraday_odd}` |
| GET | `/stream/data?region=TW` | SSE 聚合串流；事件名 `tick_stk`、`tick_fop`、`bidask_stk`、`bidask_fop`、`quote_idx`、`kbar`、`order_event`、`heartbeat` |
| POST | `/apps/{name}`（multipart `files`）| 上傳 App；`DELETE` 刪除 |

### SSE 欄位重點

- `tick_*`：`date` + `time`（台北時間）、數值多為字串（`close: "29.9"`），`tick_type` 1=外盤 2=內盤，`simtrade` 試撮要忽略。
- `bidask_*`：`bid_price[]`、`bid_volume[]`、`ask_price[]`、`ask_volume[]`（五檔）。
- `quote_idx`：首字大寫 `Close`、`Reference`、`Raise`、`Fall`、`RaiseStop`、`FallStop`…（只有日盤）。
- 連續月訂閱時 tick 回報的 `code` 是實際月份代碼（見 pitfalls #2）。

## 即時加值資料（權值股動態規劃用）

文件：`zh/tutor/market_data/streaming/enriched/index.md`。只支援 `IX0001`（加權）與 `IX0043`（櫃買）。

| 訂閱 | body | SSE 事件 |
| --- | --- | --- |
| `POST /stream/subscribe/calculated_index` | `{"index": <合約>}` | `calculated_index`：自算指數，一秒多筆，比官方指數快 |
| `POST /stream/subscribe/index_components` | `{"index": <合約>, "projection": {"kind":"ranking","target":"component","metric":"contribution","order":"abs_desc","limit":10,"group":"24"}}` | `index_components`：成分股貢獻點數排行；`entries[]` 含 `code`、`value`（貢獻點數）、`price`、`pct_chg`、`reference_weight_ppm`（權重） |
| 同上，`projection: {"kind":"group_metric","metric":"contribution"}` | | 產業類股貢獻點數 |

取消訂閱用相同 body 呼叫 `/stream/unsubscribe/...`。`group` 可省略（全市場）。

## 帳務（尚未使用，帳務頁規劃用）

皆為 `POST`，body 可帶 `{account_type: "S"|"F", broker_id, account_id}`，空物件 `{}` 用預設帳戶。

| 路徑 | 用途 |
| --- | --- |
| `/auth/accounts` | 帳戶清單 |
| `/portfolio/account_balance` | 證券交割帳戶餘額 |
| `/portfolio/margin` | 期貨保證金（權益數、可用、維持率） |
| `/portfolio/position_unit` | 庫存（`unit`: Common / Share） |
| `/portfolio/position_detail` | 庫存明細 |
| `/portfolio/profit_loss`、`/profit_loss_detail`、`/profitloss_sum` | 已實現損益（`begin_date`、`end_date`） |
| `/portfolio/settlements` | 交割款 |
| `/portfolio/trading_limits` | 額度 |

注意：使用者目前 API Key 只綁定**期權帳戶**（F002000-…）；證券帳戶的帳務需在 API 管理頁把證券帳戶加入該 Key。

## 下單（本專案禁止使用）

`/order/place_order`、`/order/cancel_order`、`/order/update_price`、`/order/update_qty`… 不得呼叫。
