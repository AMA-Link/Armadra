import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/** 每个回合行在 jsdom 里量出来的高度。 */
export const ROW_PX = 180;
export const VIEWPORT = { width: 600, height: 600 } as const;

/**
 * jsdom 没有布局：给滚动容器一个固定视口，给每个回合行固定高度，
 * `scrollHeight` 取内层撑高元素的高度。配合 {@link settleAtBottom}。
 */
export function mockLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const isRow = this.dataset.slot === "timeline-turn-row";
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: VIEWPORT.width,
        bottom: 0,
        width: VIEWPORT.width,
        height: isRow ? ROW_PX : VIEWPORT.height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
  const define = (name: string, get: (this: HTMLElement) => number): void => {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get,
    });
  };
  define("offsetHeight", function () {
    return this.dataset?.slot === "timeline-turn-row"
      ? ROW_PX
      : VIEWPORT.height;
  });
  define("offsetWidth", () => VIEWPORT.width);
  define("clientHeight", () => VIEWPORT.height);
  define("scrollHeight", function () {
    const inner = this.firstElementChild as HTMLElement | null;
    return Number.parseFloat(inner?.style?.height ?? "0") || 0;
  });
}

/** 贴底后浏览器会派发 scroll，虚拟列表据此换到末尾那一窗。 */
export function settleAtBottom(): void {
  const scroller = document.querySelector<HTMLElement>(
    "[data-slot=timeline-scroller]",
  );
  if (scroller !== null) fireEvent.scroll(scroller);
}
