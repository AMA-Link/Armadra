import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { initialPanels } from "../store/canvas/internal";
import { useSessionPage } from "../session-page/store";
import { ControlsCluster } from "./ControlsCluster";

installDomPolyfills();
afterEach(() => {
  cleanup();
  useCanvasStore.setState({ panels: initialPanels });
  useSessionPage.setState({ open: false });
});

const cluster = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="controls-cluster"]');

describe("右上工具簇", () => {
  it("没有抽屉时贴着默认边距，不写 right", () => {
    const { container } = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    expect(cluster(container)?.style.right).toBe("");
  });

  it("开着抽屉时让到抽屉左边，但窄窗口里最多让到容器内：不被推出画面", () => {
    useCanvasStore.setState({
      panels: { ...initialPanels, explorer: "drawer" },
    });
    const { container } = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    const right = cluster(container)?.style.right ?? "";
    expect(right).toContain("min(100vw, var(--drawer-w))");
    expect(right).toContain("calc(100% - 58px)");
  });

  it("窗口很矮时簇自己滚，不被裁掉", () => {
    const { container } = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    expect(cluster(container)?.className).toContain("overflow-y-auto");
  });

  it("会话页开着时不挂节点观察与画布偏好，工作空间级的钮还在（#1084）", () => {
    const labels = (container: HTMLElement) =>
      [...(cluster(container)?.querySelectorAll("button") ?? [])].map(
        (button) => button.getAttribute("aria-label"),
      );
    const closed = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    const before = labels(closed.container);
    cleanup();
    useSessionPage.setState({ open: true });
    const open = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    const after = labels(open.container);
    expect(after.length).toBe(before.length - 2);
    expect(after).toContain(before[1]);
    expect(after).not.toContain(before[0]);
    expect(after).not.toContain(before.at(-1));
  });

  it("会话页开着时是右侧整栏，不是浮着的卡片（#1088）", () => {
    const floating = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    const card = cluster(floating.container);
    expect(card?.dataset.rail).toBeUndefined();
    expect(card?.className).toContain("top-[14px]");
    cleanup();
    useSessionPage.setState({ open: true });
    const { container } = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    const rail = cluster(container);
    expect(rail?.dataset.rail).toBe("true");
    expect(rail?.className).toContain("inset-y-0");
    expect(rail?.className).toContain("w-(--cluster-rail-w)");
    expect(rail?.className).toContain("border-l");
    expect(rail?.className).not.toContain("shadow-overlay");
  });

  it("整栏遇到抽屉时让到抽屉左边", () => {
    useSessionPage.setState({ open: true });
    useCanvasStore.setState({
      panels: { ...initialPanels, explorer: "drawer" },
    });
    const { container } = render(
      <TestProviders>
        <ControlsCluster />
      </TestProviders>,
    );
    const right = cluster(container)?.style.right ?? "";
    expect(right).toContain("min(100vw, var(--drawer-w))");
    expect(right).toContain("var(--cluster-rail-w)");
  });
});
