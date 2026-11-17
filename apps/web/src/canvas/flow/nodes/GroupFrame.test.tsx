import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { CanvasNode, FrameBinding } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[], edges: [] },
  workspace: { id: "w1", rootPath: "/tmp" },
  resizeNode: vi.fn(),
  updateNodeData: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

/** GitHub 徽标自己要打接口；这里只关心它挂没挂在 Frame 上。 */
vi.mock("@/panels/github/GithubReferenceBadge", () => ({
  GithubReferenceBadge: ({ nodeId }: { nodeId: string }) => (
    <span data-testid="github-badge">{nodeId}</span>
  ),
}));

vi.mock("../overlays/WorktreeBindingBadge", () => ({
  WorktreeBindingBadge: ({ node }: { node: CanvasNode }) => (
    <span data-testid="binding-badge">{node.id}</span>
  ),
}));

import { installDomPolyfills } from "@/app/test-harness";
import { makeNode, renderNode } from "@/canvas/test-support";
import { GroupFrame } from "./GroupFrame";

/**
 * 分组 = Frame 的框、标题与徽章：worktree 绑定徽章与 GitHub 关联徽标挂在 Frame
 * 自己身上，只测「挂在不挂在」。
 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

const BINDING: FrameBinding = {
  worktreePath: "/tmp/wt",
  branch: "feature/x",
  repositoryPath: ".",
  initScript: null,
  initScriptState: "none",
  initScriptNodeId: null,
} as unknown as FrameBinding;

function group(patch: Partial<CanvasNode> = {}): CanvasNode {
  return makeNode("group", {
    title: "组",
    color: "#0a84ff",
    size: { width: 520, height: 360 },
    ...patch,
  });
}

function renderGroup(node = group(), selected = false) {
  return renderNode(<GroupFrame node={node} selected={selected} />);
}

describe("GroupFrame", () => {
  it("标题与色带用节点色", () => {
    const { container } = renderGroup(group({ color: "#ff453a" }));
    const label = container.querySelector(".canvas-group-label") as HTMLElement;
    expect(label.textContent).toBe("组");
    expect(label.style.color).toBe("rgb(255, 69, 58)");
    expect(
      (container.querySelector(".canvas-group") as HTMLElement).style
        .borderColor,
    ).toBe("rgb(255, 69, 58)");
  });

  it("选中态写在框上", () => {
    const plain = renderGroup(group(), false);
    expect(
      plain.container
        .querySelector('[data-slot="group-frame"]')
        ?.hasAttribute("data-selected"),
    ).toBe(false);
    cleanup();
    const picked = renderGroup(group(), true);
    expect(
      picked.container
        .querySelector('[data-slot="group-frame"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
  });

  it("GitHub 关联徽标挂在 Frame 上", () => {
    const node = group();
    renderGroup(node);
    expect(screen.getByTestId("github-badge").textContent).toBe(node.id);
  });

  it("没绑 worktree 时不画绑定徽章", () => {
    renderGroup();
    expect(screen.queryByTestId("binding-badge")).toBeNull();
  });

  it("绑了 worktree 就把徽章挂进 Frame，并且自己收回指针事件", () => {
    const node = group({
      data: { kind: "group", binding: BINDING },
    } as Partial<CanvasNode>);
    const { container } = renderGroup(node);
    const badge = screen.getByTestId("binding-badge");
    expect(badge.textContent).toBe(node.id);
    expect(
      (badge.parentElement as HTMLElement).classList.contains("nodrag"),
    ).toBe(true);
    expect(container.querySelector('[data-slot="group-frame"]')).not.toBeNull();
  });
});
