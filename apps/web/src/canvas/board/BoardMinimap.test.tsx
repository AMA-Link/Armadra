// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { BoardMinimap, createColorResolver } from "./BoardMinimap";
import { edgeEntity, edgeKinds } from "./edge-model";

beforeAll(installDomPolyfills);
afterEach(() => {
  cleanup();
  useMinimapPreferences.setState({ collapsed: false });
});

function board() {
  const stage = createBoard<CanvasNode>({ kinds: edgeKinds() });
  stage.scene.transact((draft) => {
    for (const [id, x] of [
      ["a", 0],
      ["b", 500],
    ] as const) {
      draft.set({
        id,
        kind: "terminal",
        x,
        y: 0,
        w: 200,
        h: 100,
        z: 1,
        data: { type: "terminal" } as unknown as CanvasNode,
      });
    }
    draft.set(edgeEntity({ id: "e", type: "link", source: "a", target: "b" }));
  });
  return stage;
}

describe("<BoardMinimap />", () => {
  it("展开时画缩略图 Canvas，收起后只剩展开钮；钮的位置随收起态变", () => {
    const stage = board();
    render(<BoardMinimap board={stage} />, { wrapper: TestProviders });
    const map = document.querySelector<HTMLElement>(".board-minimap")!;
    expect(map).not.toBeNull();
    expect(
      map.querySelector('canvas[data-board-layer="minimap"]'),
    ).not.toBeNull();
    const panel = document.querySelector<HTMLElement>(".minimap-toggle-panel")!;
    expect(panel.style.bottom).toContain("--minimap-h");

    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector(".board-minimap")).toBeNull();
    expect(panel.style.bottom).toBe("var(--navigation-bottom)");
    act(() => useMinimapPreferences.getState().setCollapsed(false));
    expect(document.querySelector(".board-minimap")).not.toBeNull();
  });
});

describe("createColorResolver", () => {
  it("把颜色交给浏览器计算并缓存；探针用完摘掉", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const resolve = createColorResolver(host);
    expect(resolve("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(host.children).toHaveLength(1);
    resolve.dispose();
    expect(host.children).toHaveLength(0);
  });
});
