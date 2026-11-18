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

## 程式結構（2026-11-18）

| 檔案 | 職責 |
| --- | --- |
| `src/types.ts` | 資料型別與 `Backend` 介面 |
| `src/api.ts` | `LiveBackend`：HTTP + SSE 串接、斷線重連、自動重新訂閱 |
| `src/mock.ts` | `DemoBackend`：假資料（`?demo=1` 或連不到 server 時） |
| `src/bs.ts` | Black-76 定價、IV、Delta |
| `src/main.ts` | 期權頁（目前唯一頁面）：指標計算、T 字報價、明細 |
| `src/style.css` | 深色主題、紅漲綠跌、手機版面 |
| `phone-server.mjs` | 手機唯讀轉接站 |

## 使用者環境

- Windows 11，專案位於 `G:\sintrade`，`.env` 也在這裡（已 gitignore）。
- shioaji 以 `uv tool install` 安裝於 `%USERPROFILE%\.local\bin`（已加入使用者 PATH）。
- PowerShell 執行原則會擋 `npm.ps1` → 一律用 `npm.cmd`。
- API Key 權限：行情／資料、帳務、正式環境；綁定 IP；**無交易權限**。
- 使用正式環境（`SJ_PRODUCTION=true`）。
- GitHub repo：`pakeguo/sintrade`（private）。
