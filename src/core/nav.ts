// 點擊商品 → 分析頁（網址 #/stocks/<代碼>，頁籤名稱「分析」）
//   個股：開啟 K 線模式；期貨／選擇權：開啟盤中走勢
// 從報價頁帶過來的完整合約（含名稱、到期日、履約價）先記在 known，分析頁就不用再查一次
import { LS } from './util';
import type { Contract, FutContract, OptContract } from '../types';

export const known = new Map<string, Contract>();

/** 代碼猜商品類別：數字開頭＝股票、三碼＋月份碼＋年＝期貨（TXFL6）、其餘＝選擇權 */
export const guessType = (c: string) => (/^\d/.test(c) ? 'STK' : /^[A-Z]{3}[A-L]\d$/.test(c) ? 'FUT' : 'OPT') as Contract['security_type'];

/** 帶商品到下單頁（模擬） */
export function openTrade(c: Contract) {
  known.set(c.code, c);
  location.hash = `#/trade/${c.code}`;
}

export function openTA(c: Contract) {
  known.set(c.code, c);
  LS.set('stkMode', c.security_type === 'STK' ? 'k' : 'live');
  location.hash = `#/stocks/${c.code}`;
}

const FUT_NAME: Record<string, string> = { TXF: '台指期', MXF: '小台', TMF: '微台' };

/** 期貨／選擇權的簡短名稱：「台指期 12月」「微台 12月」「週選 12/3 27800 買權」 */
export function derivName(c: Contract): string | null {
  const o = c as Partial<OptContract>;
  if (c.security_type === 'OPT' && o.strike && o.right && o.delivery_date) {
    const [, m, d] = o.delivery_date.split('-');
    return `${o.root === 'TXO' ? '月選' : '週選'} ${+m}/${+d} ${o.strike} ${o.right === 'C' ? '買權' : '賣權'}`;
  }
  const f = c as Partial<FutContract>;
  if (c.security_type === 'FUT' && f.delivery_month) {
    const root = c.code.slice(0, 3);
    return `${FUT_NAME[root] ?? f.name?.replace(/\s*\d{6}$/, '') ?? root} ${Number(f.delivery_month.slice(4, 6))}月`;
  }
  return null;
}
