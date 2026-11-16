import { describe, expect, it } from "vitest";

import { createDrag } from "./drag";
import { box, makeBoard, NO_MODS, pointer } from "./testing";

const world = () =>
  makeBoard([
    box("a", 0, 0),
    box("b", 200, 0),
    box("g", 0, 300, 400, 300, { kind: "group" }),
    box("child", 20, 20, 50, 50, { parent: "g" }),
  ]);
const at = (x: number, y: number) => pointer({ x, y });
const idle = { now: () => 0, request: () => 0, cancel: () => {} };
const deps = { clock: idle };

describe("drag", () => {
  it("没超过阈值是点选，超过才拖；点选发 select", () => {
    const { board, of, scene } = world();
    const g = createDrag({ board, deps }, at(10, 10), "a");
    g.move(at(12, 12));
    expect(scene.gestureActive()).toBe(false);
    g.end(at(12, 12));
    expect(of("select")).toEqual([{ ids: ["a"], additive: false }]);
    expect(of("move")).toEqual([]);
  });

  it("过程写预览，结束发 move 并清预览；未选中的实体拖动时先选中", () => {
    const { board, of, scene } = world();
    const g = createDrag({ board, deps }, at(10, 10), "a");
    g.move(at(40, 30));
    expect(scene.previewOf("a")).toEqual({ x: 30, y: 20 });
    g.end(at(40, 30));
    expect(of("select")).toEqual([{ ids: ["a"], additive: false }]);
    expect(of("move")).toEqual([
      {
        ids: ["a"],
        positions: new Map([["a", { x: 30, y: 20 }]]),
        reparent: new Map(),
      },
    ]);
    expect(scene.gestureActive()).toBe(false);
  });

  it("多选一起走，父子同选时只移父；网格吸附按主拖对象", () => {
    const { board, of } = world();
    board.setSelection(new Set(["a", "b", "g", "child"]));
    const g = createDrag(
      { board, deps: { ...deps, options: () => ({ grid: 20 }) } },
      at(10, 10),
      "a",
    );
    g.move(at(33, 10));
    g.end(at(33, 10));
    const move = of("move")[0] as {
      ids: string[];
      positions: Map<string, { x: number; y: number }>;
    };
    expect(move.ids).toEqual(["a", "b", "g"]);
    expect(move.positions.get("a")).toEqual({ x: 20, y: 0 });
    expect(move.positions.get("b")).toEqual({ x: 220, y: 0 });
  });

  it("拖进分组：reparent，坐标换算成相对分组", () => {
    const { board, of } = world();
    const g = createDrag({ board, deps }, at(10, 10), "a");
    g.move(at(110, 360));
    g.end(at(110, 360));
    const move = of("move")[0] as {
      positions: Map<string, unknown>;
      reparent: Map<string, unknown>;
    };
    expect(move.reparent).toEqual(new Map([["a", "g"]]));
    expect(move.positions.get("a")).toEqual({ x: 100, y: 50 });
  });

  it("拖出分组：reparent 为 null，留在分组上方则不变", () => {
    const { board, of } = world();
    const inside = createDrag({ board, deps }, at(30, 330), "child");
    inside.move(at(130, 380));
    inside.end(at(130, 380));
    expect(
      (of("move")[0] as { reparent: Map<string, unknown> }).reparent.size,
    ).toBe(0);
    const out = createDrag({ board, deps }, at(30, 330), "child");
    out.move(at(500, 100));
    out.end(at(500, 100));
    const move = of("move")[1] as {
      reparent: Map<string, unknown>;
      positions: Map<string, unknown>;
    };
    expect(move.reparent).toEqual(new Map([["child", null]]));
    expect(move.positions.get("child")).toEqual({ x: 490, y: 90 });
  });

  it("cancel 清预览；movable=false 只选不拖", () => {
    const { board, of, scene } = world();
    const g = createDrag({ board, deps }, at(10, 10), "a");
    g.move(at(100, 100));
    g.cancel();
    expect(scene.gestureActive()).toBe(false);
    const fixed = createDrag({ board, deps }, at(10, 10), "a", false);
    fixed.move(at(100, 100));
    fixed.end(at(100, 100));
    expect(of("move")).toEqual([]);
    expect(of("select")).toHaveLength(2);
  });

  it("Shift 点选已选实体 = 取消选中", () => {
    const { board, of } = world();
    board.setSelection(new Set(["a", "b"]));
    const shift = { ...NO_MODS, shift: true };
    const down = pointer({ x: 10, y: 10 }, { mods: shift });
    createDrag({ board, deps }, down, "a").end(down);
    expect(of("select")).toEqual([{ ids: ["b"], additive: true }]);
  });

  it("贴近视口边缘时按帧自动平移", () => {
    const { board, camera } = world();
    const frames: (() => void)[] = [];
    const clock = {
      now: () => 0,
      request: (cb: () => void) => frames.push(cb),
      cancel: () => {},
    };
    const g = createDrag({ board, deps: { clock } }, at(400, 300), "a");
    g.move(at(790, 300));
    frames.shift()!();
    expect(camera.get().x).toBeLessThan(0);
    expect(frames).toHaveLength(1);
    g.cancel();
  });
});
