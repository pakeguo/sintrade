export type SecType = 'STK' | 'FUT' | 'OPT' | 'IND' | 'WRT';

export interface Contract {
  security_type: SecType;
  exchange: string;
  code: string;
  target_code?: string | null;
}

export interface Info {
  name: string;
  reference: number;
  limit_up: number;
  limit_down: number;
}

export interface Snap {
  code: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change_price: number;
  total_volume: number;
  total_amount: number;
}

/** 時間一律用「台北當地時間當作 UTC」的秒數，圖表直接顯示台北時間 */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Tick {
  code: string;
  t: number;
  price: number;
  vol: number;
  totalVol: number;
  /** 1 = 外盤（買方主動），2 = 內盤（賣方主動），0 = 未知 */
  side: 0 | 1 | 2;
  open?: number;
  high?: number;
  low?: number;
  bidSideVol?: number;
  askSideVol?: number;
  simtrade?: boolean;
}

export interface BidAsk {
  code: string;
  bids: [number, number][];
  asks: [number, number][];
  simtrade?: boolean;
}

export interface IndexQuote {
  code: string;
  t: number;
  close: number;
  reference: number;
  open: number;
  high: number;
  low: number;
  amountSum: number;
  raise: number;
  raiseStop: number;
  fall: number;
  fallStop: number;
  flat: number;
}

export interface ScanRow {
  code: string;
  name: string;
  close: number;
  chg: number;
  pct: number;
  volume: number;
  amount: number;
}

export type ScannerType =
  | 'ChangePercentRank'
  | 'ChangePriceRank'
  | 'DayRangeRank'
  | 'VolumeRank'
  | 'AmountRank'
  | 'TickCountRank';

export type QuoteType = 'Tick' | 'BidAsk' | 'Quote';

export interface OptContract extends Contract {
  name: string;
  root: string;
  strike: number;
  right: 'C' | 'P';
  delivery_date: string;
  delivery_month: string;
  reference: number;
}

export interface FutContract extends Contract {
  name: string;
  delivery_date: string; // YYYY-MM-DD
  delivery_month: string; // YYYYMM
}

export interface OptRoot {
  root: string;
  name: string;
}

export type ConnStatus = 'connecting' | 'live' | 'down' | 'demo';

export interface Handlers {
  tick: (t: Tick) => void;
  bidask: (b: BidAsk) => void;
  index: (q: IndexQuote) => void;
  status: (s: ConnStatus) => void;
}

export interface Backend {
  readonly kind: 'live' | 'demo';
  info(): Promise<{ simulation: boolean }>;
  resolve(code: string, sec?: SecType): Promise<Contract>;
  contractInfo(c: Contract): Promise<Info>;
  snapshots(cs: Contract[]): Promise<Snap[]>;
  kbars(c: Contract, start: string, end: string): Promise<Bar[]>;
  recentTicks(c: Contract, date: string, count: number): Promise<Tick[]>;
  scanner(type: ScannerType, ascending: boolean, count: number): Promise<ScanRow[]>;
  subscribe(c: Contract, q: QuoteType): Promise<void>;
  unsubscribe(c: Contract, q: QuoteType): Promise<void>;
  /** 列出某期貨商品（如 TXF）的各月份實際合約（不含 R1/R2 連續月） */
  futuresList(root: string): Promise<FutContract[]>;
  optionRoots(): Promise<OptRoot[]>;
  optionChain(root: string): Promise<OptContract[]>;
  connect(h: Handlers): void;
}
