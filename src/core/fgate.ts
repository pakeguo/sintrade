// 期權（F）帳務查詢閘門（2026-11-27，期貨商通知查詢次數過多）
//
// 規則：期權帳務只允許在每天 05:00、08:45、13:45、14:45 各查一次（core/account.ts refreshF），其他任何時候一律禁止。
// api.ts 與 mock.ts 的 portfolio() 遇到 account_type 'F' 時先問這裡：閘門沒開就直接丟錯誤，不會送到伺服器。
// 閘門只在 refreshF 同步發出那一輪查詢的瞬間打開（fGate.run），所以日後新增的程式碼就算誤查期權帳務也會被擋下。
let open = false;
/** 被擋下的次數與最後一次的路徑（測試與除錯用） */
export const fGateLog = { blocked: 0, last: '' };

export const fGate = {
  /** 在閘門開啟的情況下「同步」執行 fn（fn 內必須同步呼叫 portfolio，await 之後就關了） */
  run<T>(fn: () => T): T {
    open = true;
    try { return fn(); } finally { open = false; }
  },
  /** portfolio() 呼叫前檢查；不允許就丟錯誤 */
  check(path: string, body: Record<string, unknown>) {
    if (body?.account_type !== 'F' || open) return;
    fGateLog.blocked++; fGateLog.last = path;
    (globalThis as unknown as { __fBlocked?: number }).__fBlocked = fGateLog.blocked;
    console.warn('[期權帳務查詢已限制]', path);
    throw new Error(`期權帳務查詢已限制（期貨商限制查詢次數，只在每天 05:00、08:45、13:45、14:45 查詢）：${path}`);
  },
};
