// 分時走勢圖的查價工具（分析頁盤中、下單頁共用）
//   - 查價線：滑鼠移到哪一分鐘，就錨定在那一分鐘的成交價（虛線＋價格軸標籤，標題為時間）
//   - 當日最高／最低：出現的那一分鐘畫箭頭＋文字，價格軸另標「最高／最低」（箭頭文字在圖表邊緣會被切掉）
// 圖表建立時請加上 INTRADAY_CROSSHAIR（關掉內建水平線、十字線時間用中文）
import {
  createSeriesMarkers, LineStyle,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { cssVar, fmtP } from '../core/util';
import type { Bar } from '../types';
import { zhTimeOptions } from './chartfmt';

export const INTRADAY_CROSSHAIR = {
  crosshair: { mode: 0, horzLine: { visible: false, labelVisible: false } },
  localization: zhTimeOptions(true).localization,   // 十字線時間標籤：11/26 10:08
} as const;

/** getBars：目前畫在圖上的 1 分 K（依時間排序，會即時增加） */
export function attachIntradayTools(chart: IChartApi, px: ISeriesApi<'Line'>, getBars: () => Bar[]) {
  const hidden = { lineVisible: false, axisLabelVisible: false };
  const hover = px.createPriceLine({ price: 0, color: cssVar('--accent'), lineStyle: LineStyle.Dashed, lineWidth: 1, ...hidden, title: '' });
  const markers = createSeriesMarkers(px, []);
  const hiLine = px.createPriceLine({ price: 0, color: 'rgba(240,82,79,.55)', lineStyle: LineStyle.Dotted, lineWidth: 1, ...hidden, title: '最高' });
  const loLine = px.createPriceLine({ price: 0, color: 'rgba(34,176,125,.55)', lineStyle: LineStyle.Dotted, lineWidth: 1, ...hidden, title: '最低' });
  let key = '';

  const barAt = (t: number): Bar | undefined => {
    const bars = getBars();
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1, x = bars[m].t; if (x === t) return bars[m]; if (x < t) lo = m + 1; else hi = m - 1; }
    return undefined;
  };
  chart.subscribeCrosshairMove((e) => {
    const b = e.time != null && e.point ? barAt(e.time as number) : undefined;
    if (!b) { hover.applyOptions(hidden); return; }
    hover.applyOptions({ price: b.c, lineVisible: true, axisLabelVisible: true, title: new Date(b.t * 1000).toISOString().slice(11, 16) });
  });

  /** 資料重設或有新成交時呼叫；最高／最低有變動才重畫 */
  function update(reset = false) {
    if (reset) key = '';
    const bars = getBars();
    if (!bars.length) { if (key !== 'empty') { markers.setMarkers([]); hiLine.applyOptions(hidden); loLine.applyOptions(hidden); key = 'empty'; } return; }
    let hi = bars[0], lo = bars[0];
    for (const b of bars) { if (b.h > hi.h) hi = b; if (b.l < lo.l) lo = b; }
    const k = `${hi.t}:${hi.h}|${lo.t}:${lo.l}`;
    if (k === key) return;
    key = k;
    const ms: SeriesMarker<Time>[] = [
      { time: hi.t as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: cssVar('--up'), text: `最高 ${fmtP(hi.h)}` },
      { time: lo.t as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: cssVar('--down'), text: `最低 ${fmtP(lo.l)}` },
    ];
    markers.setMarkers(ms.sort((a, b) => (a.time as number) - (b.time as number)));
    hiLine.applyOptions({ price: hi.h, lineVisible: true, axisLabelVisible: true });
    loLine.applyOptions({ price: lo.l, lineVisible: true, axisLabelVisible: true });
  }
  return { update };
}
