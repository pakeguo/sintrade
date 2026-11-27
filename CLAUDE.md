# CLAUDE.md

個人專屬看盤軟體（永豐 Shioaji）。使用者以繁體中文溝通，回覆一律用繁體中文。

**開始任何工作前，先讀 `docs/ai/` 目錄**：

| 檔案 | 內容 |
| --- | --- |
| `docs/ai/README.md` | 專案概況、目前架構、使用者環境 |
| `docs/ai/pitfalls.md` | **踩過的坑與根因（必讀）**：期貨換月、部署、server 連線、Windows 環境 |
| `docs/ai/decisions.md` | 已確定的設計決策與理由 |
| `docs/ai/requirements.md` | 使用者需求與待確認問題（全面看盤軟體規劃） |
| `docs/ai/shioaji-api.md` | 本專案用到的 shioaji server HTTP / SSE API 格式 |

## 工作守則

- 使用者的電腦是 Windows 11，指令要給 PowerShell 可用的版本（`npm.cmd`、`curl.exe`）。
- 本專案**只看盤、不下單**；任何新增功能都不得呼叫 `/api/v1/order/*`，除非使用者明確要求並確認。
- **下單防堵四層不得移除或繞過**（下單頁目前只做模擬委託）：① `src/core/guard.ts`（攔截 fetch／XHR／sendBeacon／EventSource／WebSocket）② `src/api.ts` 的 `req()` ③ `vite.config.ts` 建置掃描（出現送單路徑就建置失敗）④ `phone-server.mjs` 白名單。改下單頁後要跑 `node tests/ui/trade.cjs`（必須 ✓ PASS）。
- **期權（F）帳務只能在每天 05:00、08:45、13:45、14:45 查詢**（期貨商限制）：只能由 `core/account.ts` 的 `refreshF` 透過 `fGate.run` 查詢，不得新增其他期權帳務查詢；改帳務相關程式後要跑 `node tests/ui/fquery.cjs`（必須 ✓ PASS）。
- `.env` 含 API 金鑰，永遠不可 commit、不可印出內容。
- 修 bug 或踩到新坑時，**把根因與解法補進 `docs/ai/pitfalls.md`**。
- 新的設計決策寫進 `docs/ai/decisions.md`。
- 重繪迴圈（frame）一律加 `!pointerHeld()` 判斷，否則實盤時按鈕點不到（pitfalls #12）。
- 頁面訂閱行情一律透過 `hub.acquire/release`（見 `docs/ai/README.md` 規則）。
- 改 CSS／版面後，先 `npx vite --port 5173`，再跑 `node tests/ui/layout.cjs`、`node tests/ui/clicks.cjs`、`node tests/ui/trade.cjs` 與 `node tests/ui/fquery.cjs`（所有頁面，1920×912），不能只測改的那一頁（pitfalls #16）。
- 頁面專屬 class 用頁面前綴（`stk-`、`ov-`、`pd-`、`ac-`、`td-`），避免撞名。
- 改完前端要能 `npx tsc --noEmit` 與 `npx vite build` 通過；可用 `?demo=1` 以假資料預覽。
