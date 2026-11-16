// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Item } from "../../whiteboard/model";

const calls: [string, ...unknown[]][] = [];
class FakePath {
  constructor(public d?: string) {}
}
class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return new Proxy(
      { measureText: (t: string) => ({ width: t.length * 8 }) } as Record<
        string,
        unknown
      >,
      {
        get(target, name: string) {
          if (name in target) return target[name];
          return (...args: unknown[]) => void calls.push([name, ...args]);
        },
        set(target, name: string, value) {
          calls.push([`set:${name}`, value]);
          target[name] = value;
          return true;
        },
      },
    );
  }
  convertToBlob() {
    return Promise.resolve(new Blob(["png"], { type: "image/png" }));
  }
}

const { exportItemsPng } = await import("./export");
const { rasterizeItems, RasterError } = await import("../../whiteboard/raster");

const style = { color: "red", size: "m" } as const;
const shape = (id: string, z: number, x = 0): Item =>
  ({
    id,
    kind: "shape",
    x,
    y: 0,
    w: 100,
    h: 60,
    z,
    style,
    geo: "rectangle",
  }) as Item;

/** 形状先平移到自己的原点再平移回来：只取前一半。 */
const drawn = (list: [string, ...unknown[]][]) =>
  list.map((c) => c[1] as number).filter((x) => x >= 0 && !Object.is(x, -0));

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("Path2D", FakePath);
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
});

describe("exportItemsPng", () => {
  it("用屏幕同一套 paint 画到离屏画布，按 z 升序，颜色取指定的那一套", async () => {
    const blob = await exportItemsPng([shape("b", 2, 200), shape("a", 1, 0)], {
      scheme: "light",
      background: "#fff",
    });
    expect(blob.type).toBe("image/png");
    expect(calls).toContainEqual(["set:fillStyle", "#fff"]);
    const strokes = calls.filter(([n]) => n === "set:strokeStyle");
    expect(strokes).toHaveLength(2);
    // 浅色 red = #e03131
    expect(strokes[0]![1]).toBe("#e03131");
    const translates = calls.filter(([n]) => n === "translate");
    expect(drawn(translates)).toEqual([0, 200]);
  });

  it("上带对象排在下带之后（遮挡带语义与屏幕一致）", async () => {
    await exportItemsPng(
      [shape("over", 1_000_000, 300), shape("under", 5, 0)],
      {},
    );
    const translates = calls.filter(([n]) => n === "translate");
    expect(drawn(translates)).toEqual([0, 300]);
  });
});

describe("rasterizeItems", () => {
  it("校验先于引擎：空选区、不合法密度被拒", async () => {
    await expect(rasterizeItems([])).rejects.toBeInstanceOf(RasterError);
    await expect(
      rasterizeItems([shape("a", 1)], { scale: 0 }),
    ).rejects.toBeInstanceOf(RasterError);
  });

  it("通过校验后得到 PNG", async () => {
    const blob = await rasterizeItems([shape("a", 1)]);
    expect(blob.type).toBe("image/png");
  });
});
