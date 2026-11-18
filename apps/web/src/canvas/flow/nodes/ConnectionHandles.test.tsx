import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { BoardHostProvider } from "@/canvas/board/host-context";
import { ConnectionHandles } from "./ConnectionHandles";

/** 节点的连线端口：形状与可达性。 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

function inBoard(node: React.ReactNode) {
  return render(<BoardHostProvider value>{node}</BoardHostProvider>);
}

function handles(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="connection-handle"]',
    ),
  ];
}

describe("起笔把手", () => {
  it("四边各一个，引擎按 `data-board-handle` 认", () => {
    const { container } = inBoard(<ConnectionHandles />);
    const found = handles(container);
    expect(found.map((node) => node.dataset.side)).toEqual([
      "top",
      "right",
      "bottom",
      "left",
    ]);
    for (const handle of found) {
      expect(handle.dataset.boardHandle).toBe(handle.dataset.side);
      expect(handle.classList.contains("board-connection-handle")).toBe(true);
    }
  });

  it("四个把手都有无障碍名字；不分进出，都叫「连线」", () => {
    const { container } = inBoard(<ConnectionHandles />);
    expect(handles(container).map((h) => h.getAttribute("aria-label"))).toEqual(
      ["连线", "连线", "连线", "连线"],
    );
  });
});

describe("不画把手的情形", () => {
  it("只作落点（分组与白板对象）不画起笔把手", () => {
    const { container } = inBoard(<ConnectionHandles dropOnly />);
    expect(handles(container)).toHaveLength(0);
  });

  it("不在画板宿主里（手机焦点页）：不画把手，也不抛错", () => {
    const { container } = render(<ConnectionHandles />);
    expect(handles(container)).toHaveLength(0);
  });
});
