import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { initialPanels } from "../store/canvas/internal";
import { ControlsCluster } from "./ControlsCluster";

installDomPolyfills();
afterEach(() => {
  cleanup();
  useCanvasStore.setState({ panels: initialPanels });
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
});
