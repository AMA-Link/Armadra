import { describe, expect, it } from "vitest";

import { createResize } from "./resize";
import { box, makeBoard, pointer } from "./testing";
import type { GestureDeps } from "./types";

const at = (x: number, y: number) => pointer({ x, y });
const run = (
  g: {
    move(p: ReturnType<typeof at>): void;
    end(p: ReturnType<typeof at>): void;
  } | null,
  to: [number, number],
) => {
  g!.move(at(...to));
  g!.end(at(...to));
};
describe("resize", () => {
  const setup = (deps: GestureDeps = {}) => {
    const t = makeBoard([box("a", 100, 100, 200, 100)]);
    return { ...t, deps };
  };

  it("东南把手改宽高，结束发 resize 并清预览", () => {
    const { board, of, scene, deps } = setup();
    const g = createResize({ board, deps }, at(300, 200), "a", "se");
    g!.move(at(350, 230));
    expect(scene.previewOf("a")).toEqual({ x: 100, y: 100, w: 250, h: 130 });
    g!.end(at(350, 230));
    expect(of("resize")).toEqual([
      { id: "a", box: { x: 100, y: 100, w: 250, h: 130 } },
    ]);
    expect(scene.gestureActive()).toBe(false);
  });

  it("西北把手移动左上角；不会小于 min", () => {
    const { board, of, deps } = setup({
      kind: () => ({ layer: "world", resize: { min: { w: 80, h: 60 } } }),
    });
    run(createResize({ board, deps }, at(100, 100), "a", "nw"), [1000, 1000]);
    expect(of("resize")).toEqual([
      { id: "a", box: { x: 220, y: 140, w: 80, h: 60 } },
    ]);
  });

  it("keepAspect 保持比例，边把手对侧居中", () => {
    const { board, of, deps } = setup({
      kind: () => ({
        layer: "world",
        resize: { min: { w: 20, h: 20 }, keepAspect: true },
      }),
    });
    run(createResize({ board, deps }, at(300, 150), "a", "e"), [400, 150]);
    expect(of("resize")).toEqual([
      { id: "a", box: { x: 100, y: 75, w: 300, h: 150 } },
    ]);
  });

  it("widthOnly 忽略纵向；resize: false 不接管；网格吸附", () => {
    const { board, of, deps } = setup({
      kind: () => ({
        layer: "world",
        resize: { min: { w: 20, h: 20 }, widthOnly: true },
      }),
    });
    run(createResize({ board, deps }, at(300, 200), "a", "se"), [333, 400]);
    expect(of("resize")).toEqual([
      { id: "a", box: { x: 100, y: 100, w: 233, h: 100 } },
    ]);
    const off = {
      kind: () => ({ layer: "world" as const, resize: false as const }),
    };
    expect(createResize({ board, deps: off }, at(0, 0), "a", "se")).toBeNull();
    const grid = setup({ options: () => ({ grid: 50 }) });
    run(
      createResize(
        { board: grid.board, deps: grid.deps },
        at(300, 200),
        "a",
        "se",
      ),
      [333, 214],
    );
    expect(grid.of("resize")).toEqual([
      { id: "a", box: { x: 100, y: 100, w: 250, h: 100 } },
    ]);
  });

  it("子实体的 box 是相对父级的坐标；没动不发事件", () => {
    const t = makeBoard([
      box("g", 500, 500, 400, 400),
      box("c", 10, 10, 100, 100, { parent: "g" }),
    ]);
    const g = createResize(
      { board: t.board, deps: {} },
      at(610, 610),
      "c",
      "se",
    );
    g!.end(at(610, 610));
    expect(t.of("resize")).toEqual([]);
    run(
      createResize({ board: t.board, deps: {} }, at(610, 610), "c", "se"),
      [640, 640],
    );
    expect(t.of("resize")).toEqual([
      { id: "c", box: { x: 10, y: 10, w: 130, h: 130 } },
    ]);
  });
});
