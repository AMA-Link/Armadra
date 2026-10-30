import { describe, expect, it } from "vitest";

import { helloNeedsResize, sizeAfterHello } from "./use-transport";

describe("helloNeedsResize", () => {
  it("does not resize when the local container already matches the hello", () => {
    expect(
      helloNeedsResize({ cols: 120, rows: 40 }, { cols: 120, rows: 40 }),
    ).toBe(false);
  });

  it("resizes when either dimension differs", () => {
    expect(
      helloNeedsResize({ cols: 120, rows: 40 }, { cols: 40, rows: 40 }),
    ).toBe(true);
    expect(
      helloNeedsResize({ cols: 120, rows: 40 }, { cols: 120, rows: 12 }),
    ).toBe(true);
  });
});

describe("sizeAfterHello（#614）", () => {
  const hello = { cols: 69, rows: 18 };

  it("量到了且不同：把本地尺寸报上去", () => {
    expect(sizeAfterHello(hello, { cols: 120, rows: 30 }, true)).toBe("report");
  });

  it("没量到：不报 xterm 的缺省 80×24，先对齐 core 开的尺寸", () => {
    expect(sizeAfterHello(hello, { cols: 80, rows: 24 }, false)).toBe("adopt");
  });

  it("本地已与 hello 一致：什么都不做，量没量到都一样", () => {
    expect(sizeAfterHello(hello, { cols: 69, rows: 18 }, true)).toBe("none");
    expect(sizeAfterHello(hello, { cols: 69, rows: 18 }, false)).toBe("none");
  });
});
