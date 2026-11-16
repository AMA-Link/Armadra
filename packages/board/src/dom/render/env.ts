// 渲染层依赖的浏览器能力：可注入，测试里换成假的。
export interface RenderEnv {
  raf(callback: () => void): number;
  caf(handle: number): void;
  /** 监听元素尺寸变化；返回退订。没有 ResizeObserver 的环境退化成空操作。 */
  observe(element: Element, callback: () => void): () => void;
  dpr(): number;
}

export function browserEnv(): RenderEnv {
  return {
    raf: (callback) => requestAnimationFrame(callback),
    caf: (handle) => cancelAnimationFrame(handle),
    observe(element, callback) {
      if (typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(callback);
      observer.observe(element);
      return () => observer.disconnect();
    },
    dpr: () => globalThis.devicePixelRatio || 1,
  };
}
