import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PlatformComponent } from "@armadra/shared";

import { ComponentList } from "./ComponentList";

afterEach(cleanup);

function component(
  kind: PlatformComponent["kind"],
  pid: number,
  tree = false,
): PlatformComponent {
  return {
    kind,
    location: "local",
    process: {
      pid,
      startTimeUnixMs: null,
      name: kind,
      parentPid: null,
      memoryBytes: 1024 * 1024,
      cpuPercent: 1,
    },
    tree,
    childCount: tree ? 0 : null,
    children: [],
    unknownReason: null,
  } as PlatformComponent;
}

describe("平台组件列表", () => {
  it("列出桌面壳报上来的进程，只有 Runtime 那一行说会话在上面", () => {
    render(
      <ComponentList
        components={[
          component("runtime", 1),
          component("shellMain", 2),
          component("shellGpu", 3),
          component("browserGuest", 4),
          component("browserWorker", 5, true),
        ]}
      />,
    );
    expect(screen.getByText("桌面主进程")).toBeTruthy();
    expect(screen.getByText("GPU 进程")).toBeTruthy();
    expect(screen.getByText("浏览器节点页面")).toBeTruthy();
    // 没有说明小字，也没有解释性的悬停提示。
    expect(screen.queryByText(/只算这个进程/)).toBeNull();
    expect(
      screen
        .getAllByRole("listitem")
        .every((item) => !item.hasAttribute("title")),
    ).toBe(true);
  });
});
