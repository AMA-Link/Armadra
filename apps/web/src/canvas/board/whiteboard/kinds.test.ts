import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "@armadra/board/core";
import type { DomKindSpec, DomPaintEnv } from "@armadra/board/dom";

import { OVER_Z } from "../../whiteboard/bands";
import type { Item } from "../../whiteboard/model";
import { setEditing } from "./text-edit";
import { whiteboardKinds, wbKindOf } from "./kinds";

class FakePath {
  constructor(public d?: string) {}
}

function fakeCtx() {
  const calls: [string, ...unknown[]][] = [];
  const ctx = new Proxy(
    {
      measureText: (t: string) => ({ width: t.length * 10 }),
    } as Record<string, unknown>,
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
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const env = (image?: unknown): DomPaintEnv => ({
  zoom: 1,
  dpr: 1,
  theme: "light",
  color: (name) => `#${name}`,
  image: () => image as never,
  selected: false,
});

const style = { color: "blue", size: "m" } as const;
const base = { x: 10, y: 20, w: 100, h: 50, z: 1, style };
const entity = (item: Item, geo?: Partial<Entity<Item>>): Entity<Item> => ({
  id: `wb:${item.id}`,
  kind: wbKindOf(item),
  x: item.x,
  y: item.y,
  w: item.w,
  h: item.h,
  z: item.z,
  data: item,
  ...geo,
});
const kinds = (): Record<string, DomKindSpec<Item>> =>
  whiteboardKinds() as never;
const specOf = (item: Item) => kinds()[wbKindOf(item)]!;

beforeEach(() => {
  vi.stubGlobal("Path2D", FakePath);
  setEditing(null);
});

describe("白板种类注册", () => {
  it("每种两档：下带 canvas-under，上带 canvas-over，z 决定带", () => {
    const table = whiteboardKinds();
    expect(Object.keys(table)).toHaveLength(10);
    expect(table["wb.ink"]!.layer).toBe("canvas-under");
    expect(table["wb.ink:over"]!.layer).toBe("canvas-over");
    const ink = { id: "a", kind: "ink", ...base, points: [] } as Item;
    expect(wbKindOf(ink)).toBe("wb.ink");
    expect(wbKindOf({ ...ink, z: OVER_Z })).toBe("wb.ink:over");
  });

  it("resize 规则：文字只调宽、图片锁比例、直线不走框", () => {
    const t = kinds();
    expect(t["wb.text"]!.resize).toMatchObject({ widthOnly: true });
    expect(t["wb.image"]!.resize).toMatchObject({ keepAspect: true });
    expect(t["wb.line"]!.resize).toBe(false);
  });
});

describe("paint", () => {
  it("墨迹：按「当前盒 / 原始盒」缩放，路径按对象缓存", () => {
    const ink = {
      id: "a",
      kind: "ink",
      ...base,
      points: [
        [0, 0, 0.5],
        [50, 25, 0.5],
        [100, 50, 0.5],
      ],
      origin: { w: 100, h: 50 },
    } as unknown as Item;
    const { ctx, calls } = fakeCtx();
    specOf(ink).paint!(ctx, entity(ink, { w: 200, h: 100 }), env());
    expect(calls).toContainEqual(["translate", 10, 20]);
    expect(calls).toContainEqual(["scale", 2, 2]);
    const first = calls.find(([n]) => n === "fill")![1];
    expect(first).toBeInstanceOf(FakePath);
    const again = fakeCtx();
    specOf(ink).paint!(again.ctx, entity(ink, { w: 200, h: 100 }), env());
    expect(again.calls.find(([n]) => n === "fill")![1]).toBe(first);
  });

  it("高亮笔半透明且 multiply", () => {
    const ink = {
      id: "a",
      kind: "ink",
      ...base,
      highlight: true,
      points: [[0, 0, 0.5]],
    } as unknown as Item;
    const { ctx, calls } = fakeCtx();
    specOf(ink).paint!(ctx, entity(ink), env());
    expect(calls).toContainEqual(["set:globalAlpha", 0.35]);
    expect(calls).toContainEqual(["set:globalCompositeOperation", "multiply"]);
  });

  it("形状：虚线、半透明填充与描边", () => {
    const shape = {
      id: "s",
      kind: "shape",
      ...base,
      geo: "rectangle",
      style: { ...style, dash: "dashed", fill: "semi" },
    } as Item;
    const { ctx, calls } = fakeCtx();
    specOf(shape).paint!(ctx, entity(shape), env());
    const names = calls.map(([n]) => n);
    expect(names).toContain("fill");
    expect(names).toContain("stroke");
    expect(
      (calls.find(([n]) => n === "setLineDash")![1] as number[]).length,
    ).toBe(2);
    expect(calls).toContainEqual(["set:strokeStyle", "#blue"]);
  });

  it("形状标签居中排版；编辑中不画", () => {
    const shape = {
      id: "s",
      kind: "shape",
      ...base,
      geo: "ellipse",
      label: "判断",
    } as Item;
    const a = fakeCtx();
    specOf(shape).paint!(a.ctx, entity(shape), env());
    expect(a.calls.some(([n]) => n === "fillText")).toBe(true);
    setEditing({ id: "wb:s", field: "label" });
    const b = fakeCtx();
    specOf(shape).paint!(b.ctx, entity(shape), env());
    expect(b.calls.some(([n]) => n === "fillText")).toBe(false);
  });

  it("直线：折点按当前盒缩放，箭头多一笔", () => {
    const line = {
      id: "l",
      kind: "line",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: 1,
      style,
      points: [
        [0, 0],
        [100, 100],
      ],
      arrowEnd: true,
    } as Item;
    const { ctx, calls } = fakeCtx();
    specOf(line).paint!(ctx, entity(line, { w: 200 }), env());
    expect(calls).toContainEqual(["moveTo", 0, 0]);
    expect(calls).toContainEqual(["lineTo", 200, 100]);
    expect(calls.filter(([n]) => n === "stroke")).toHaveLength(2);
  });

  it("文字：折行逐行 fillText，空文字不画", () => {
    const text = {
      id: "t",
      kind: "text",
      ...base,
      w: 60,
      text: "hello world",
    } as Item;
    const { ctx, calls } = fakeCtx();
    specOf(text).paint!(ctx, entity(text), env());
    expect(calls.filter(([n]) => n === "fillText").length).toBeGreaterThan(1);
    const empty = fakeCtx();
    const blank = { ...text, text: "" } as Item;
    specOf(blank).paint!(empty.ctx, entity(blank), env());
    expect(empty.calls.some(([n]) => n === "fillText")).toBe(false);
  });

  it("图片：位图到位画位图，没到位画占位框", () => {
    const image = {
      id: "i",
      kind: "image",
      ...base,
      assetPath: ".armadra/assets/0123456789abcdef.png",
    } as Item;
    const ready = fakeCtx();
    const bitmap = {};
    specOf(image).paint!(ready.ctx, entity(image), env(bitmap));
    expect(ready.calls).toContainEqual(["drawImage", bitmap, 10, 20, 100, 50]);
    const waiting = fakeCtx();
    specOf(image).paint!(waiting.ctx, entity(image), env());
    expect(waiting.calls.some(([n]) => n === "strokeRect")).toBe(true);
    expect(waiting.calls.some(([n]) => n === "drawImage")).toBe(false);
  });
});

describe("hit", () => {
  const hit = (item: Item, x: number, y: number, geo?: Partial<Entity<Item>>) =>
    specOf(item).hit!(entity(item, geo), { x, y }, 4);

  it("空心形状只命中轮廓，实心形状命中内部", () => {
    const hollow = {
      id: "s",
      kind: "shape",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: 1,
      style,
      geo: "rectangle",
    } as Item;
    expect(hit(hollow, 50, 50)).toBe(false);
    expect(hit(hollow, 0, 50)).toBe(true);
    const solid = { ...hollow, style: { ...style, fill: "solid" } } as Item;
    expect(hit(solid, 50, 50)).toBe(true);
  });

  it("墨迹：命中线上，不命中包围盒空处；缩放后按原始盒换算", () => {
    const ink = {
      id: "a",
      kind: "ink",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: 1,
      style,
      points: [
        [0, 0, 0.5],
        [100, 100, 0.5],
      ],
      origin: { w: 100, h: 100 },
    } as unknown as Item;
    expect(hit(ink, 50, 50)).toBe(true);
    expect(hit(ink, 90, 10)).toBe(false);
    expect(hit(ink, 100, 100, { w: 200, h: 200 })).toBe(true);
    expect(hit(ink, 100, 20, { w: 200, h: 200 })).toBe(false);
  });

  it("直线：命中线段附近", () => {
    const line = {
      id: "l",
      kind: "line",
      x: 0,
      y: 0,
      w: 100,
      h: 0,
      z: 1,
      style,
      points: [
        [0, 0],
        [100, 0],
      ],
    } as Item;
    expect(hit(line, 50, 2)).toBe(true);
    expect(hit(line, 50, 30)).toBe(false);
  });
});
