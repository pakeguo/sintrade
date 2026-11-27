// 圖表時間軸中文格式：刻度 2026／8月／7/10／13:30，十字線標籤 2026/07/10 或 07/10 13:30
import { TickMarkType, type Time } from 'lightweight-charts';

const D = (t: Time) => new Date((t as number) * 1000).toISOString();   // 台北時間當 UTC（types.ts Bar.t）

export function zhTimeOptions(minute: boolean) {
  return {
    localization: {
      locale: 'zh-TW',
      timeFormatter: (t: Time) => { const d = D(t); return minute ? `${d.slice(5, 10).replace('-', '/')} ${d.slice(11, 16)}` : d.slice(0, 10).replace(/-/g, '/'); },
    },
    timeScale: {
      tickMarkFormatter: (t: Time, type: TickMarkType) => {
        const d = D(t);
        switch (type) {
          case TickMarkType.Year: return d.slice(0, 4);
          case TickMarkType.Month: return `${+d.slice(5, 7)}月`;
          case TickMarkType.DayOfMonth: return `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
          default: return d.slice(11, 16);
        }
      },
    },
  };
}
