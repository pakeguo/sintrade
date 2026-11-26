// 分時圖縮放限制：可以放大（看局部），但不能縮小到超出交易時段，也不能拖到時段外 → 左右不留白
// 搭配「⟲ 重置」按鈕回到完整時段並恢復價格軸自動縮放
import type { IChartApi } from 'lightweight-charts';

/** getRange：完整時段的邏輯範圍（含兩端邊距），例如 { from: -6, to: 276 } */
export function limitZoom(chart: IChartApi, getRange: () => { from: number; to: number } | null) {
  let fixing = false;
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (fixing || !r) return;
    const full = getRange();
    if (!full) return;
    const fw = full.to - full.from;
    let from: number = r.from, to: number = r.to;
    const w = to - from;
    if (w >= fw - 0.01) { from = full.from; to = full.to; }       // 縮小超過完整時段 → 固定在完整時段
    else if (from < full.from) { from = full.from; to = from + w; } // 拖到左邊外 → 貼齊左緣
    else if (to > full.to) { to = full.to; from = to - w; }         // 拖到右邊外 → 貼齊右緣
    else return;
    if (Math.abs(from - r.from) < 0.01 && Math.abs(to - r.to) < 0.01) return;
    fixing = true;
    chart.timeScale().setVisibleLogicalRange({ from, to });
    fixing = false;
  });
}

/** 重置：完整時段＋價格軸自動縮放 */
export function resetZoom(chart: IChartApi, full: { from: number; to: number }) {
  chart.priceScale('right').applyOptions({ autoScale: true });
  chart.timeScale().setVisibleLogicalRange(full);
}
