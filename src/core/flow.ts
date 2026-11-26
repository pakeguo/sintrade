// 逐筆成交分級（散戶／中實戶／大戶／法人級）：分析頁與下單頁共用
import { store } from './store';

/** 混合分級：金額與張數都達標才算該級（低等級因此較寬）。
 *  預設：散戶 <100萬或≤2張、中實戶 ≥100萬且≥3張、大戶 ≥500萬且≥10張、法人級 ≥2,000萬且≥50張 */
export const tierOf = (amt: number, lots: number) => {
  const [a, b, c] = store.data.bigTiers;
  const [la, lb, lc] = store.data.bigLots ?? [3, 10, 50];
  return amt >= c && lots >= lc ? 3 : amt >= b && lots >= lb ? 2 : amt >= a && lots >= la ? 1 : 0;
};
export const TIER = ['散戶', '中實戶', '大戶', '法人級'];
export const TIER_COLOR = ['#8b95a3', '#8fb3ff', '#f5b94a', '#d17cff'];
