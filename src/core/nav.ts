// 點擊商品時要去哪裡：之後會換成「技術分析窗口」（docs/ai/requirements.md 第 8 輪）
// 在那之前：個股 → 現有個股頁的 K 線模式；期貨／選擇權 → 期權頁
import { LS } from './util';
import type { Contract } from '../types';

export function openTA(c: Contract) {
  if (c.security_type === 'STK') {
    LS.set('stkMode', 'k');
    location.hash = `#/stocks/${c.code}`;
    return;
  }
  location.hash = '#/options';
}
