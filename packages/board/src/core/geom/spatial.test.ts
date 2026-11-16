import { describe, expect, it } from "vitest";
import { createGridIndex } from "./spatial";

const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const sorted = (a: string[]) => [...a].sort();

describe("createGridIndex", () => {
  it("insert / get / has / size", () => {
    const idx = createGridIndex();
    idx.insert("a", r(0, 0, 10, 10));
    expect(idx.has("a")).toBe(true);
    expect(idx.get("a")).toEqual(r(0, 0, 10, 10));
    expect(idx.size).toBe(1);
    expect(idx.get("x")).toBeUndefined();
  });
  it("queryRect 跨格去重", () => {
    const idx = createGridIndex();
    idx.insert("a", r(500, 500, 100, 100));
    expect(idx.queryRect(r(0, 0, 2000, 2000))).toEqual(["a"]);
    expect(idx.queryRect(r(520, 520, 1, 1))).toEqual(["a"]);
    expect(idx.queryRect(r(2000, 2000, 5, 5))).toEqual([]);
  });
  it("格内包围盒不相交时不命中", () => {
    const idx = createGridIndex();
    idx.insert("a", r(0, 0, 10, 10));
    expect(idx.queryRect(r(100, 100, 5, 5))).toEqual([]);
    expect(idx.queryPoint({ x: 5, y: 5 })).toEqual(["a"]);
    expect(idx.queryPoint({ x: 50, y: 5 })).toEqual([]);
  });
  it("update 移动后旧位置查不到", () => {
    const idx = createGridIndex();
    idx.insert("a", r(0, 0, 10, 10));
    idx.update("a", r(5000, 5000, 10, 10));
    expect(idx.queryPoint({ x: 5, y: 5 })).toEqual([]);
    expect(idx.queryPoint({ x: 5005, y: 5005 })).toEqual(["a"]);
    expect(idx.size).toBe(1);
  });
  it("remove", () => {
    const idx = createGridIndex();
    idx.insert("a", r(0, 0, 10, 10));
    idx.remove("a");
    idx.remove("nope");
    expect(idx.size).toBe(0);
    expect(idx.queryRect(r(-10, -10, 100, 100))).toEqual([]);
  });
  it("大对象走旁路表，可更新与删除", () => {
    const idx = createGridIndex();
    idx.insert("big", r(0, 0, 512 * 20, 512 * 20));
    idx.insert("s", r(10, 10, 5, 5));
    expect(sorted(idx.queryPoint({ x: 12, y: 12 }))).toEqual(["big", "s"]);
    expect(idx.queryPoint({ x: 9000, y: 9000 })).toEqual(["big"]);
    idx.update("big", r(0, 0, 10, 10));
    expect(idx.queryPoint({ x: 9000, y: 9000 })).toEqual([]);
    idx.update("s", r(0, 0, 512 * 20, 10));
    idx.remove("s");
    expect(idx.queryPoint({ x: 9000, y: 5 })).toEqual([]);
  });
  it("负坐标", () => {
    const idx = createGridIndex();
    idx.insert("n", r(-600, -600, 100, 100));
    expect(idx.queryPoint({ x: -550, y: -550 })).toEqual(["n"]);
  });
  it("查询范围远大于占用格时遍历占用格", () => {
    const idx = createGridIndex();
    idx.insert("a", r(0, 0, 10, 10));
    idx.insert("b", r(100000, 0, 10, 10));
    expect(sorted(idx.queryRect(r(-1e6, -1e6, 2e6, 2e6)))).toEqual(["a", "b"]);
    expect(idx.queryRect(r(-1e6, 1e5, 2e6, 1))).toEqual([]);
  });
  it("clear 与自定义格大小", () => {
    const idx = createGridIndex<number>(10, 2);
    idx.insert(1, r(0, 0, 5, 5));
    idx.insert(2, r(0, 0, 100, 5));
    expect(idx.queryPoint({ x: 50, y: 2 })).toEqual([2]);
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.queryPoint({ x: 1, y: 1 })).toEqual([]);
  });
});
