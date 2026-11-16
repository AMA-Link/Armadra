import { describe, expect, it } from "vitest";

import { createMarquee } from "./marquee";
import { box, makeBoard, NO_MODS, pointer } from "./testing";

const scene = () =>
  makeBoard([
    box("a", 0, 0),
    box("b", 150, 0),
    box("c", 0, 300, 100, 100, { ends: undefined }),
  ]);

describe("marquee", () => {
  it("框住的实体结束时发 select，过程中给出矩形反馈", () => {
    const { board, of } = scene();
    const feedback: unknown[] = [];
    const g = createMarquee(
      { board, deps: { feedback: (f) => feedback.push(f) } },
      pointer({ x: -10, y: -10 }),
    );
    g.move(pointer({ x: 120, y: 120 }));
    g.end(pointer({ x: 120, y: 120 }));
    expect(of("select")).toEqual([{ ids: ["a"], additive: false }]);
    expect(feedback.at(-1)).toBeNull();
    expect(feedback[0]).toMatchObject({
      type: "marquee",
      rect: { x: -10, w: 130 },
    });
  });

  it("完全包含模式下只选整个落进框里的", () => {
    const { board, of } = scene();
    const deps = { options: () => ({ marqueeContain: true }) };
    const g = createMarquee({ board, deps }, pointer({ x: 50, y: -10 }));
    g.end(pointer({ x: 300, y: 120 }));
    expect(of("select")).toEqual([{ ids: ["b"], additive: false }]);
  });

  it("没拖动等于点空白：清空选区；Shift 则保持", () => {
    const { board, of } = scene();
    board.setSelection(new Set(["a"]));
    createMarquee({ board, deps: {} }, pointer({ x: 500, y: 500 })).end(
      pointer({ x: 500, y: 500 }),
    );
    const shift = pointer(
      { x: 500, y: 500 },
      { mods: { ...NO_MODS, shift: true } },
    );
    createMarquee({ board, deps: {} }, shift).end(shift);
    expect(of("select")).toEqual([
      { ids: [], additive: false },
      { ids: ["a"], additive: true },
    ]);
  });

  it("Shift 框选对已有选区做增减", () => {
    const { board, of } = scene();
    board.setSelection(new Set(["a"]));
    const shift = { ...NO_MODS, shift: true };
    const g = createMarquee(
      { board, deps: {} },
      pointer({ x: -10, y: -10 }, { mods: shift }),
    );
    g.end(pointer({ x: 300, y: 120 }, { mods: shift }));
    expect(of("select")).toEqual([{ ids: ["b"], additive: true }]);
  });

  it("边拖边发 select：选区变了才发，松手时不重复", () => {
    const { board, of } = scene();
    const g = createMarquee({ board, deps: {} }, pointer({ x: -10, y: -10 }));
    g.move(pointer({ x: 50, y: 50 }));
    g.move(pointer({ x: 60, y: 60 }));
    g.move(pointer({ x: 300, y: 120 }));
    g.end(pointer({ x: 300, y: 120 }));
    expect(of("select")).toEqual([
      { ids: ["a"], additive: false },
      { ids: ["a", "b"], additive: false },
    ]);
  });

  it("拖出去又缩回没有命中：选区清空也发出来", () => {
    const { board, of } = scene();
    const g = createMarquee({ board, deps: {} }, pointer({ x: -10, y: -10 }));
    g.move(pointer({ x: 50, y: 50 }));
    g.move(pointer({ x: -5, y: -5 }));
    g.end(pointer({ x: -5, y: -5 }));
    expect(of("select")).toEqual([
      { ids: ["a"], additive: false },
      { ids: [], additive: false },
    ]);
  });

  it("Shift 边拖边发也以开始时的选区为基准", () => {
    const { board, of } = scene();
    board.setSelection(new Set(["a"]));
    const shift = { ...NO_MODS, shift: true };
    const g = createMarquee(
      { board, deps: {} },
      pointer({ x: -10, y: -10 }, { mods: shift }),
    );
    g.move(pointer({ x: 50, y: 50 }, { mods: shift }));
    g.move(pointer({ x: 300, y: 120 }, { mods: shift }));
    g.end(pointer({ x: 300, y: 120 }, { mods: shift }));
    expect(of("select")).toEqual([
      { ids: [], additive: true },
      { ids: ["b"], additive: true },
    ]);
  });
});
