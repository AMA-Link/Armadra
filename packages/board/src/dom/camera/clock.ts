// 相机动画用的时钟：缺省是 rAF；测试注入可控时钟。
export interface Clock {
  now(): number;
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export const browserClock: Clock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};
