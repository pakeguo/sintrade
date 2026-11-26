// 三大法人買賣超（盤後資訊，證交所 T86＋櫃買）
// 瀏覽器不能直接抓證交所（沒開 CORS）→ 由轉接站 phone-server.mjs 的 /mw/inst 代抓：
//   從 localhost:5180 開啟 → 同網域；從 shioaji server（:8080/apps/mywatch/）開啟 → 跨站呼叫 localhost:5180（轉接站允許本機來源）
import { hub } from './hub';

export interface InstRow { code: string; name: string; mkt: 'TSE' | 'OTC'; foreign: number; trust: number; dealer: number } // 單位：股
export interface InstData { date: string; rows: InstRow[] }

let cache: { at: number; data: InstData } | null = null;

async function tryGet(url: string): Promise<InstData> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => null) as (InstData & { message?: string }) | null;
  if (!r.ok || !j?.rows) throw new Error(j?.message ?? `HTTP ${r.status}`);
  return j;
}

export async function loadInst(): Promise<InstData> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
  let data: InstData;
  if (hub.env === 'demo') data = await demo();
  else {
    try { data = await tryGet('/mw/inst'); }
    catch {
      try { data = await tryGet('http://localhost:5180/mw/inst'); }
      catch (e) {
        const msg = String((e as Error)?.message ?? e);
        throw new Error(/fetch|network|abort|timeout/i.test(msg)
          ? '法人買賣超要由「轉接站」代抓證交所資料：請在專案資料夾另開一個 PowerShell 執行 npm.cmd run phone，並保持視窗開著'
          : msg);
      }
    }
  }
  cache = { at: Date.now(), data };
  return data;
}

/** DEMO：用成交量排行的股票產生假的法人買賣超 */
async function demo(): Promise<InstData> {
  const list = await hub.be.scanner('VolumeRank', true, 60);
  const d = new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
  return {
    date: d,
    rows: list.map((x, i) => ({
      code: x.code, name: x.name, mkt: 'TSE',
      foreign: Math.round(Math.sin(i * 2.7) * 8_000_000), trust: Math.round(Math.cos(i * 1.9) * 2_500_000), dealer: Math.round(Math.sin(i) * 600_000),
    })),
  };
}
