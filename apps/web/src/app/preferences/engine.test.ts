import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANVAS_ENGINE_KEY,
  storedCanvasEngine,
  writeCanvasEngine,
} from "./engine";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

describe("画布引擎开关", () => {
  it("缺省是 current", () => {
    expect(storedCanvasEngine()).toBe("current");
  });

  it("存过 next 就读到 next，写入走同一个键", () => {
    writeCanvasEngine("next");
    expect(localStorage.getItem(CANVAS_ENGINE_KEY)).toBe("next");
    expect(storedCanvasEngine()).toBe("next");
  });

  it("手改成别的值一律当 current", () => {
    localStorage.setItem(CANVAS_ENGINE_KEY, "tldraw");
    expect(storedCanvasEngine()).toBe("current");
  });
});
