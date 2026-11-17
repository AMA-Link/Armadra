// @vitest-environment jsdom
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity } from "../core";
import { createBoard, type DomBoard } from "../dom";
import {
  BoardView,
  EntityHosts,
  Overlay,
  WorldOverlay,
  useBoard,
  useCamera,
  useEntity,
  useGestureActive,
  useSelected,
} from ".";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entity = (id: string, x = 0, y = 0, kind = "card"): Entity<string> => ({
  id,
  kind,
  x,
  y,
  w: 100,
  h: 80,
  z: 0,
  data: id,
});

let root: Root;
let mountPoint: HTMLElement;
let board: DomBoard<string>;

const put = (...entities: Entity<string>[]) =>
  act(
    () =>
      void board.scene.transact((d) => entities.forEach((e) => d.set(e)), {
        history: "ignore",
      }),
  );

const show = (ui: React.ReactNode) =>
  act(() => root.render(<BoardView board={board as DomBoard}>{ui}</BoardView>));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  board = createBoard<string>({ kinds: { card: { layer: "world" } } });
  mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  root = createRoot(mountPoint);
});
afterEach(() => {
  act(() => root.unmount());
  board.destroy();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("BoardView", () => {
  it("挂载板，卸载后拆掉 DOM 但保留场景与监听（严格模式可重挂）", () => {
    show(null);
    const stage = mountPoint.firstElementChild!;
    expect(stage.querySelector("[data-board-layer=world]")).not.toBeNull();
    act(() => root.render(null));
    expect(board.slots()).toBeNull();
    show(null);
    expect(mountPoint.querySelectorAll("[data-board-layer=world]").length).toBe(
      1,
    );
  });

  it("子树在挂载之后才渲染，useBoard 拿到同一个板", () => {
    const seen: unknown[] = [];
    const Probe = () => (seen.push(useBoard()), null);
    show(<Probe />);
    expect(seen[0]).toBe(board);
  });

  it("板之外调用 useBoard 抛出明确的错误", () => {
    const Bad = () => (useBoard(), null);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => act(() => root.render(<Bad />))).toThrow(/BoardView/);
    error.mockRestore();
  });
});

describe("EntityHosts", () => {
  let calls: string[] = [];
  const render = (e: Entity<string>) => {
    calls.push(e.id);
    return <span data-testid={e.id}>{e.data}</span>;
  };
  beforeEach(() => {
    calls = [];
  });

  it("每个 world 实体的宿主里长出应用的节点，增删实体增删 portal", () => {
    put(entity("a"), entity("b", 300));
    show(<EntityHosts<string> render={render} />);
    expect(board.hostOf("a")!.textContent).toBe("a");
    expect(board.hostOf("b")!.textContent).toBe("b");
    put(entity("c", 600));
    expect(board.hostOf("c")!.textContent).toBe("c");
    act(
      () =>
        void board.scene.transact((d) => d.remove("a"), { history: "ignore" }),
    );
    expect(board.hostOf("a")).toBeUndefined();
    expect(mountPoint.querySelector("[data-testid=a]")).toBeNull();
  });

  it("拖动预览与几何变化只由引擎写宿主 style，不触发任何节点重渲", () => {
    put(entity("a"), entity("b", 300));
    show(<EntityHosts<string> render={render} />);
    const before = calls.length;
    act(() => board.scene.preview(new Map([["a", { x: 50, y: 60 }]])));
    expect(board.hostOf("a")!.style.transform).toBe("translate(50px, 60px)");
    act(() => board.scene.clearPreview());
    // 改几何但实体 data 引用不变：同一个实体对象换成新对象会渲染该节点一次，其它节点不动
    put({ ...entity("a", 10, 20), data: "a" });
    expect(board.hostOf("a")!.style.transform).toBe("translate(10px, 20px)");
    const rendered = calls.slice(before);
    expect(rendered.every((id) => id === "a")).toBe(true);
    expect(rendered.length).toBeLessThanOrEqual(1);
  });

  it("相机平移不重渲任何节点", () => {
    put(entity("a"));
    show(<EntityHosts<string> render={render} />);
    const before = calls.length;
    act(() => board.camera.set({ x: 100, y: 50, zoom: 1.5 }));
    expect(calls.length).toBe(before);
  });

  it("同一 id 删后重建：换了新宿主，子树跟过去", () => {
    put(entity("a"));
    show(<EntityHosts<string> render={render} />);
    const first = board.hostOf("a");
    act(() => {
      board.scene.transact((d) => d.remove("a"), { history: "ignore" });
      board.scene.transact((d) => d.set(entity("a")), { history: "ignore" });
    });
    expect(board.hostOf("a")).not.toBe(first);
    expect(board.hostOf("a")!.textContent).toBe("a");
  });

  it("filter 只渲染选中的种类", () => {
    put(entity("a"), entity("g", 0, 0, "card"));
    show(<EntityHosts<string> render={render} filter={(e) => e.id === "g"} />);
    expect(board.hostOf("a")!.textContent).toBe("");
    expect(board.hostOf("g")!.textContent).toBe("g");
  });
});

describe("hooks", () => {
  it("useCamera：只在选中的切片变化时重渲", () => {
    let renders = 0;
    const Zoom = () => {
      renders += 1;
      return <b data-testid="zoom">{useCamera((c) => c.zoom)}</b>;
    };
    show(<Zoom />);
    const first = renders;
    act(() => board.camera.set({ x: 40, y: 0, zoom: 1 }));
    expect(renders).toBe(first);
    act(() => board.camera.set({ x: 40, y: 0, zoom: 2 }));
    expect(mountPoint.querySelector("[data-testid=zoom]")!.textContent).toBe(
      "2",
    );
    expect(renders).toBe(first + 1);
  });

  it("useCamera：返回对象时浅比较相等不重渲", () => {
    let renders = 0;
    const Pan = () => {
      renders += 1;
      useCamera((c) => ({ zoom: c.zoom }));
      return null;
    };
    show(<Pan />);
    const first = renders;
    act(() => board.camera.set({ x: 9, y: 9, zoom: 1 }));
    expect(renders).toBe(first);
  });

  it("useEntity 订阅单个实体；useSelected 跟选区；useGestureActive 跟手势", () => {
    put(entity("a"), entity("b", 300));
    const log: string[] = [];
    const Probe = () => {
      const a = useEntity<string>("a");
      const selected = useSelected("a");
      const active = useGestureActive();
      log.push(`${a?.x}|${selected}|${active}`);
      return null;
    };
    show(<Probe />);
    expect(log.at(-1)).toBe("0|false|false");
    put(entity("b", 999));
    const afterOther = log.length;
    put(entity("a", 5));
    expect(log.at(-1)).toBe("5|false|false");
    expect(log.length).toBe(afterOther + 1);
    act(() => board.setSelection(new Set(["a"])));
    expect(log.at(-1)).toBe("5|true|false");
    act(() => board.emit("gesture", { active: true }));
    expect(log.at(-1)).toBe("5|true|true");
  });
});

describe("Overlay / WorldOverlay", () => {
  it("分别进叠加层的屏幕插槽、世界坐标 HTML 与 SVG 插槽", () => {
    show(
      <>
        <Overlay>
          <i data-testid="screen" />
        </Overlay>
        <WorldOverlay>
          <i data-testid="world" />
        </WorldOverlay>
        <WorldOverlay layer="svg">
          <circle data-testid="svg" r={1} />
        </WorldOverlay>
      </>,
    );
    const slots = board.slots()!;
    expect(slots.screen.querySelector("[data-testid=screen]")).not.toBeNull();
    expect(slots.worldHtml.querySelector("[data-testid=world]")).not.toBeNull();
    expect(slots.worldSvg.querySelector("[data-testid=svg]")).not.toBeNull();
  });
});
