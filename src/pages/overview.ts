import { blueprintPage } from './blueprint';

// 需求來源：docs/ai/requirements.md 第 1–4 輪
export const overviewPage = blueprintPage('overview', '總覽', '打開軟體第一眼看全局：大盤、期權、權值股、我的帳戶。（下一個實作的頁面）', [
  { title: '大盤', items: ['加權指數、櫃買指數', '漲跌家數、漲跌停家數', '成交金額與昨量比較'] },
  { title: '台指期近月', items: ['價格、漲跌', '日盤基差／夜盤較現貨收盤', '自動換月'] },
  { title: '期權摘要', items: ['價平 IV、偏斜', '到期預期區間', 'P/C 量比、量能壓力／支撐'], accent: true },
  { title: '權值股前 10（精簡版）', items: ['報價、漲跌幅', '貢獻點數紅綠長條', '點一下跳到個股頁'], span: 2, tall: true },
  { title: '產業類股貢獻', items: ['半導體、金融、電子零組件…', '各類股對大盤貢獻點數'], tall: true },
  { title: '今日損益', items: ['已實現＋未實現合計', '即時跳動'], accent: true },
  { title: '期貨權益與風險', items: ['權益數、可用保證金', '風險指標（維持率）'] },
  { title: '持倉概況', items: ['期權部位與股票庫存', '各自即時損益'] },
]);
