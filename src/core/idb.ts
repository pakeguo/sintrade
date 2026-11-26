// IndexedDB 小工具：存 K 棒歷史（資料量大，localStorage 放不下）
// 打不開（無痕模式、被封鎖）時一律當作沒有快取，不影響功能
const DB = 'mw-bars', ST = 'hist';
let dbp: Promise<IDBDatabase | null> | null = null;

function db() {
  dbp ??= within(new Promise<IDBDatabase | null>((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(ST);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch { res(null); }
  }), 4000, null);
  return dbp;
}

/** 另一個分頁占住資料庫或瀏覽器異常時，最多等 4 秒就當作沒有快取（pitfalls #24） */
const within = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return within(idbGet0<T>(key), 4000, undefined);
}
async function idbGet0<T>(key: string): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((res) => {
    try {
      const r = d.transaction(ST, 'readonly').objectStore(ST).get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => res(undefined);
    } catch { res(undefined); }
  });
}

export async function idbSet(key: string, val: unknown): Promise<void> {
  return within(idbSet0(key, val), 8000, undefined);
}
async function idbSet0(key: string, val: unknown): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((res) => {
    try {
      const tx = d.transaction(ST, 'readwrite');
      tx.objectStore(ST).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
      tx.onabort = () => res();
    } catch { res(); }
  });
}
