import { blueprintPage } from './blueprint';

export const accountPage = blueprintPage('account', '帳務', '期權＋證券帳戶，損益用即時行情計算、權益數定時向永豐校正。（第二個實作的頁面）', [
  { title: '期權帳戶・權益', items: ['權益數、可用保證金、原始／維持保證金', '風險指標（維持率），低於門檻變色'], accent: true },
  { title: '期權帳戶・未平倉部位', items: ['商品、方向、口數、成本、現價', '未實現損益即時跳動', '選擇權部位顯示 Delta、到期日'], span: 2, tall: true },
  { title: '證券帳戶・庫存', items: ['股票、股數、成本、現價、市值', '未實現損益與報酬率即時跳動', '點一下跳到個股頁'], span: 2, tall: true },
  { title: '證券帳戶・交割款', items: ['今日／明日／後日應收付', '可用餘額'] },
  { title: '已實現損益', items: ['今日／本週／本月', '期權與證券分開統計'], span: 3 },
]);
