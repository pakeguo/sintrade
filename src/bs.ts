// Black-76（以期貨/合成期貨為標的，利率視為 0）：定價、隱含波動率、Delta

function ncdf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

export function price(F: number, K: number, T: number, vol: number, right: 'C' | 'P'): number {
  if (T <= 0 || vol <= 0) return Math.max(0, right === 'C' ? F - K : K - F);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return right === 'C' ? F * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - F * ncdf(-d1);
}

export function delta(F: number, K: number, T: number, vol: number, right: 'C' | 'P'): number {
  if (T <= 0 || vol <= 0) return right === 'C' ? (F > K ? 1 : 0) : (F < K ? -1 : 0);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  return right === 'C' ? ncdf(d1) : ncdf(d1) - 1;
}

/** 二分法求隱含波動率；價格低於內含價值或無法收斂時回傳 NaN */
export function impliedVol(p: number, F: number, K: number, T: number, right: 'C' | 'P'): number {
  if (!(p > 0) || !(F > 0) || !(T > 0)) return NaN;
  const intrinsic = Math.max(0, right === 'C' ? F - K : K - F);
  if (p <= intrinsic + 1e-9) return NaN;
  let lo = 0.001, hi = 5;
  if (price(F, K, T, hi, right) < p) return NaN;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (price(F, K, T, mid, right) > p) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/** 台北時間現在到到期日 13:30（最後交易時刻）的年化時間 */
export function yearsToExpiry(deliveryDate: string, nowMs = Date.now()): number {
  const [y, m, d] = deliveryDate.split('-').map(Number);
  // 13:30 台北 = 05:30 UTC
  const exp = Date.UTC(y, m - 1, d, 5, 30);
  return Math.max(exp - nowMs, 60_000) / (365 * 24 * 3600 * 1000);
}
