// 下單絕對防堵（docs/ai/decisions.md「下單頁」）
//
// 目前階段：程式內「沒有」任何送單功能，下單頁只做模擬委託（core/simorder.ts）。
// 為了防止日後誤加、或第三方程式碼送出委託，啟動時把瀏覽器所有對外通道包一層：
//   fetch、XMLHttpRequest、navigator.sendBeacon、EventSource、WebSocket
// 只要網址指向 shioaji server 的下單／改單／刪單或成交回報路徑，一律在送出前擋下並丟出錯誤。
// 另外：api.ts 的 req() 也會再擋一次；vite.config.ts 建置時掃描輸出檔，出現送單路徑就讓建置失敗；
// phone-server.mjs 也封鎖這些路徑（手機端）。
//
// 解除封鎖必須由使用者明確要求並確認（CLAUDE.md），且要同時修改以上四處。

/** 下單相關路徑：/api/v1/order/...、成交回報訂閱（stream 的 trade 類）、帳務以外的任何「place／cancel／update」動作 */
const BLOCK = [
  /\/api\/v\d+\/order(?:[/?#]|$)/i,
  /\/api\/v\d+\/stream\/[^?#]*trade/i,
  /(place|cancel|update)_?(order|price|qty)/i,
];

export function isOrderUrl(url: unknown): boolean {
  let s = '';
  try { s = typeof url === 'string' ? url : url instanceof URL ? url.href : url instanceof Request ? url.url : String(url ?? ''); } catch { s = ''; }
  try { s = decodeURIComponent(s); } catch { /* 保留原字串 */ }
  return BLOCK.some((re) => re.test(s));
}

export class OrderBlockedError extends Error {
  constructor(url: string) { super(`已封鎖下單相關連線（本程式只看盤、模擬下單）：${url}`); this.name = 'OrderBlockedError'; }
}

let installed = false;
export const blockedLog: { at: number; url: string }[] = [];

function blocked(url: unknown): never {
  const u = String(url instanceof Request ? url.url : url);
  blockedLog.push({ at: Date.now(), url: u });
  console.error('[下單防堵]', u);
  throw new OrderBlockedError(u);
}

export function installOrderGuard() {
  if (installed) return;
  installed = true;
  const w = window as unknown as Record<string, unknown>;

  const origFetch = window.fetch.bind(window);
  const guardedFetch: typeof fetch = (input, init) => {
    if (isOrderUrl(input)) return Promise.reject(new OrderBlockedError(String(input instanceof Request ? input.url : input)))
      .finally(() => blockedLog.push({ at: Date.now(), url: String(input) }));
    return origFetch(input, init);
  };
  Object.defineProperty(window, 'fetch', { value: guardedFetch, writable: false, configurable: false });

  const xo = XMLHttpRequest.prototype.open;
  Object.defineProperty(XMLHttpRequest.prototype, 'open', {
    value: function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (isOrderUrl(url)) blocked(url);
      return (xo as (...a: unknown[]) => void).call(this, method, url, ...rest);
    },
    writable: false, configurable: false,
  });

  if (navigator.sendBeacon) {
    const sb = navigator.sendBeacon.bind(navigator);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (url: string | URL, data?: BodyInit | null) => (isOrderUrl(url) ? (blocked(url), false) : sb(url, data)),
      writable: false, configurable: false,
    });
  }

  for (const name of ['EventSource', 'WebSocket'] as const) {
    const Orig = w[name] as (new (url: string | URL, opt?: unknown) => object) | undefined;
    if (!Orig) continue;
    const Guarded = function (url: string | URL, opt?: unknown) {
      if (isOrderUrl(url)) blocked(url);
      return new Orig(url, opt);
    } as unknown as typeof Orig;
    // 靜態常數（EventSource.OPEN 等）不可列舉，Object.assign 複製不到 → 逐一定義
    for (const k of Object.getOwnPropertyNames(Orig)) {
      if (['prototype', 'length', 'name', 'caller', 'arguments'].includes(k)) continue;
      try { Object.defineProperty(Guarded, k, Object.getOwnPropertyDescriptor(Orig, k)!); } catch { /* 略過 */ }
    }
    (Guarded as unknown as { prototype: unknown }).prototype = Orig.prototype;
    Object.defineProperty(window, name, { value: Guarded, writable: false, configurable: false });
  }
}
