import { describe, expect, it } from "vitest";

import { box, makeBoard, NO_MODS, pointer } from "./testing";
import { createHandTool, createSelectTool } from "./tools";
import type { GestureDeps } from "./types";
import type { HitTarget, PointerInput } from "../types";

const { board } = makeBoard([box("a", 0, 0), box("t", 200, 0)]);
const begin = (
  target: HitTarget,
  extra: Partial<PointerInput> = {},
  deps: GestureDeps = {},
) =>
  createSelectTool(deps).begin(
    pointer({ x: 5, y: 5 }, { target, ...extra }),
    board,
  )?.name ?? null;

describe("select 工具状态转移", () => {
  it("空白：左键框选，中键 / 空格 / 触屏平移，右键不接管", () => {
    const blank = { type: "blank" } as const;
    expect(begin(blank)).toBe("marquee");
    expect(begin(blank, { button: 1 })).toBe("pan");
    expect(begin(blank, { mods: { ...NO_MODS, space: true } })).toBe("pan");
    expect(begin(blank, { type: "touch" })).toBe("pan");
    expect(begin(blank, { button: 2 })).toBeNull();
  });

  it("实体拖拽区拖动，可编辑区放手", () => {
    expect(begin({ type: "entity", id: "a", part: "body" })).toBe("drag");
    expect(begin({ type: "editable" })).toBeNull();
  });

  it("有 dragHandle 的种类，body 不拖动只选中", () => {
    const deps = {
      kind: () => ({ layer: "world" as const, dragHandle: ".title" }),
    };
    const body = createSelectTool(deps).begin(
      pointer(
        { x: 5, y: 5 },
        { target: { type: "entity", id: "a", part: "body" } },
      ),
      board,
    )!;
    body.move(pointer({ x: 100, y: 100 }));
    body.end(pointer({ x: 100, y: 100 }));
    expect(board.scene.gestureActive()).toBe(false);
    expect(
      begin({ type: "entity", id: "a", part: "drag-handle" }, {}, deps),
    ).toBe("drag");
  });

  it("把手：resize 或 connect；只读时不接管把手，实体只能选", () => {
    expect(begin({ type: "handle", id: "a", handle: "se" })).toBe("resize");
    expect(begin({ type: "handle", id: "a", handle: "right" })).toBe("connect");
    const readOnly = { options: () => ({ readOnly: true }) };
    expect(
      begin({ type: "handle", id: "a", handle: "se" }, {}, readOnly),
    ).toBeNull();
    expect(begin({ type: "entity", id: "a", part: "body" }, {}, readOnly)).toBe(
      "drag",
    );
  });

  it("手形：左 / 中键平移，任何位置", () => {
    const tool = createHandTool();
    expect(
      tool.begin(
        pointer({ x: 0, y: 0 }, { target: { type: "editable" } }),
        board,
      )?.name,
    ).toBe("pan");
    expect(
      tool.begin(pointer({ x: 0, y: 0 }, { button: 2 }), board),
    ).toBeNull();
  });
});
