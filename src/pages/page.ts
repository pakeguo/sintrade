/** 每一頁的共同介面：切到這頁時 mount，離開時 unmount（必須退訂行情、清除計時器） */
export interface Page {
  id: string;
  title: string;
  mount(el: HTMLElement): void | Promise<void>;
  unmount(): void;
}
