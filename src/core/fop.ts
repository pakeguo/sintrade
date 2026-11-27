// 期貨／選擇權（臺指）交易規格：契約乘數、升降單位、手續費（使用者可改）、期交稅
// 下單頁（模擬）的損益試算、兩平點、模擬部位共用
import { LS } from './util';
import type { Contract } from '../types';

export const isOpt = (c: Contract | null | undefined) => c?.security_type === 'OPT';
const root = (code: string) => code.slice(0, 3);

/** 每點價值（元）：大台 200、小台 50、微台 10、臺指選擇權 50 */
export function fopMult(c: Contract): number {
  if (isOpt(c)) return 50;
  return ({ TXF: 200, MXF: 50, TMF: 10 } as Record<string, number>)[root(c.code)] ?? 200;
}

/** 升降單位：期貨 1 點；選擇權 <10:0.1、<50:0.5、<500:1、<1000:5、其餘 10 */
export function fopTick(p: number, opt: boolean): number {
  if (!opt) return 1;
  return p < 10 ? 0.1 : p < 50 ? 0.5 : p < 500 ? 1 : p < 1000 ? 5 : 10;
}

/** 手續費（每口單邊，元）：先用常見值，使用者可在下單頁修改（存 localStorage mw.fopFee） */
export const FEE_DEFAULT: Record<string, number> = { TXF: 50, MXF: 25, TMF: 12, OPT: 15 };
export const feeKey = (c: Contract) => (isOpt(c) ? 'OPT' : root(c.code) in FEE_DEFAULT ? root(c.code) : 'TXF');
export function fopFee(c: Contract): number {
  const m = LS.getJSON<Record<string, number>>('fopFee', {});
  const k = feeKey(c);
  return Number.isFinite(m[k]) ? m[k] : FEE_DEFAULT[k];
}
export function setFopFee(c: Contract, v: number) {
  const m = LS.getJSON<Record<string, number>>('fopFee', {});
  m[feeKey(c)] = v;
  LS.setJSON('fopFee', m);
}

/** 期交稅率：期貨 0.002%（契約金額）、選擇權 0.1%（權利金），每邊各收，四捨五入到元 */
export const fopTaxRate = (c: Contract) => (isOpt(c) ? 0.001 : 0.00002);
export const fopTax = (c: Contract, price: number, qty: number) => Math.round(price * fopMult(c) * qty * fopTaxRate(c));

/** 單筆委託上限（口）：期貨 100、選擇權 200 */
export const fopMaxQty = (c: Contract) => (isOpt(c) ? 200 : 100);
