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
- `.env` 含 API 金鑰，永遠不可 commit、不可印出內容。
- 修 bug 或踩到新坑時，**把根因與解法補進 `docs/ai/pitfalls.md`**。
- 新的設計決策寫進 `docs/ai/decisions.md`。
- 頁面訂閱行情一律透過 `hub.acquire/release`（見 `docs/ai/README.md` 規則）。
- 改完前端要能 `npx tsc --noEmit` 與 `npx vite build` 通過；可用 `?demo=1` 以假資料預覽。
