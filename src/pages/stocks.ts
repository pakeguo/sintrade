import { blueprintPage } from './blueprint';

export const stocksPage = blueprintPage('stocks', '個股', '左側自選清單（庫存自動置頂），右側可切換「盤中」與「K 線分析」兩種模式。（第三個實作的頁面）', [
  { title: '自選清單', items: ['庫存持股自動置頂', '自選股可分組', '上方搜尋代碼／名稱', '漲跌顏色、迷你走勢'], tall: true },
  { title: '盤中模式', items: ['分時走勢＋VWAP（當日均價線）', '五檔＋委買委賣力道', '逐筆成交明細、大單標示', '內外盤比'], span: 2, tall: true, accent: true },
  { title: '個股資訊', items: ['參考價、漲跌停', '昨量、量比', '融資融券、處置／注意股'] },
  { title: 'K 線分析模式', items: ['日／週／月 K', '均線 MA5／10／20／60＋成交量', 'RSI、布林通道', '分價量表（籌碼價位）'], span: 2, tall: true },
]);
