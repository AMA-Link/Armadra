// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createResolveTarget } from "./target";

const dom = (html: string) => {
  document.body.innerHTML = html;
  return (selector: string) => document.querySelector(selector);
};
const world = { x: 5, y: 6 };

describe("resolveTarget 缺省约定", () => {
  const q = dom(`
    <div data-board-id="card">
      <div class="title" data-board-drag-handle><span class="label"></span></div>
      <div class="body"><input class="field" data-board-editable /><p class="text"></p></div>
      <i class="grip" data-board-handle="se"></i>
      <i class="side" data-board-handle="right"></i>
    </div>
    <div class="loose" data-board-drag-handle></div>
    <div class="empty"></div>`);
  const resolve = createResolveTarget();

  it("data-board-id 是实体 body，drag-handle 在其内才算拖拽区", () => {
    expect(resolve(q(".text"), world)).toEqual({
      type: "entity",
      id: "card",
      part: "body",
    });
    expect(resolve(q(".label"), world)).toEqual({
      type: "entity",
      id: "card",
      part: "drag-handle",
    });
  });

  it("可编辑区优先，引擎放手", () => {
    expect(resolve(q(".field"), world)).toEqual({ type: "editable" });
  });

  it("把手带宿主 id；孤立的 drag-handle 不算实体", () => {
    expect(resolve(q(".grip"), world)).toEqual({
      type: "handle",
      id: "card",
      handle: "se",
    });
    expect(resolve(q(".side"), world)).toEqual({
      type: "handle",
      id: "card",
      handle: "right",
    });
    expect(resolve(q(".loose"), world)).toEqual({ type: "blank" });
  });

  it("DOM 里没有时问 Canvas 对象，再没有才是空白", () => {
    const hit = createResolveTarget((p) =>
      p.x === 5 ? { type: "entity", id: "ink1", part: "body" } : null,
    );
    expect(hit(q(".empty"), world)).toEqual({
      type: "entity",
      id: "ink1",
      part: "body",
    });
    expect(hit(q(".empty"), { x: 0, y: 0 })).toEqual({ type: "blank" });
    expect(hit(null, { x: 0, y: 0 })).toEqual({ type: "blank" });
  });
});
