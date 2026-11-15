import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "workspace-1", rootPath: "/tmp" } as {
    id: string;
    rootPath: string;
  } | null,
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(() => "new-node"),
  setPanel: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

const target = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/panels/github/forge-target", () => ({
  useForgeTarget: () => target.current,
}));

const api = vi.hoisted(() => ({
  forgeIssues: vi.fn(),
  forgePulls: vi.fn(),
  forgeFacets: vi.fn(),
  forgeIssue: vi.fn(),
  forgePull: vi.fn(),
}));
vi.mock("../api/forge", async (original) => ({
  ...(await original<typeof import("../api/forge")>()),
  ...api,
}));
vi.mock("@/canvas/placement", () => ({
  nodeDropPosition: () => ({ x: 1, y: 2 }),
}));
vi.mock("@/canvas/created-node", () => ({ revealCreatedNode: vi.fn() }));

import { forgePullExtSchema } from "../api/forge";
import { usePreferencesStore } from "@/app/preferences-store";
import { ForgeNode } from "./ForgeNode";

const REPO = { host: "git.example.test", owner: "acme", name: "app" };
const DETECTION = {
  repository: REPO,
  forge: "gitea" as const,
  source: "config" as const,
  configKey: "git.example.test",
  apiBase: "https://git.example.test/api/v1",
  webUrl: "https://git.example.test/acme/app",
  credential: true,
  accountLogin: "bot",
};
const AT = 1_788_557_900_000;

const pull = (number: number, title: string, extra = {}) =>
  forgePullExtSchema.parse({
    number,
    title,
    body: "",
    state: "open",
    draft: false,
    author: "alice",
    baseRef: "main",
    headRef: "x",
    headSha: "a".repeat(40),
    mergeable: "mergeable",
    url: `https://git.example.test/acme/app/pulls/${number}`,
    createdAtMs: AT,
    updatedAtMs: AT,
    mergedAtMs: null,
    ...extra,
  });

const forgeNode = (data: Record<string, unknown> = {}) =>
  ({
    id: "66666666-6666-4666-8666-666666666666",
    boardId: "b1",
    type: "forge",
    title: "代码托管",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: {
      kind: "forge",
      repo: null,
      tab: "pulls",
      query: "",
      view: "list",
      open: null,
      ...data,
    },
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
  }) as unknown as CanvasNode;

function view(node: CanvasNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ForgeNode
        id={node.id}
        node={node}
        selected={false}
        collapsed={false}
        focused={false}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  target.current = { status: "ready", detection: DETECTION };
  for (const fn of Object.values(api)) fn.mockReset();
  api.forgeFacets.mockRejectedValue(new Error("501"));
  api.forgeIssues.mockResolvedValue({ items: [], nextCursor: null });
  api.forgePulls.mockResolvedValue({
    items: [
      pull(7, "feat: search", {
        reviewDecision: "changesRequested",
        checks: { rollup: "failure", passed: 5, total: 7 },
        commentCount: 2,
      }),
      pull(8, "wip", { reviewDecision: "approved" }),
    ],
    nextCursor: null,
  });
  store.updateNodeData.mockClear();
  store.addNode.mockClear();
});
afterEach(cleanup);

describe("画布代码托管节点（#934）", () => {
  it("节点体是面板的同一份列表：行、CI、审查圆点、评论数", async () => {
    view(forgeNode());
    expect(await screen.findByText("feat: search")).toBeTruthy();
    expect(
      document.querySelector("[data-slot=forge-row-ci]")?.textContent,
    ).toBe("5/7");
    expect(
      document.querySelectorAll("[data-slot=forge-row-review]").length,
    ).toBe(2);
  });

  it("头部切到看板：只写视图，按 开启 / 审查中 / 已合并 分列", async () => {
    const { rerender } = view(forgeNode());
    await screen.findByText("feat: search");
    fireEvent.click(screen.getByRole("radio", { name: "看板" }));
    expect(store.updateNodeData).toHaveBeenCalledWith(
      "66666666-6666-4666-8666-666666666666",
      { tab: "pulls", query: "", view: "board", open: null },
    );
    cleanup();
    view(forgeNode({ view: "board" }));
    await screen.findByText("feat: search");
    const columns = [
      ...document.querySelectorAll("[data-slot=forge-board-column]"),
    ];
    expect(columns.map((el) => el.getAttribute("data-column"))).toEqual([
      "open",
      "review",
      "merged",
    ]);
    // 要求修改的进「审查中」，已批准的留在「开启」。
    const inColumn = (id: string) =>
      document.querySelector(`[data-column=${id}]`)?.textContent ?? "";
    expect(inColumn("review")).toContain("feat: search");
    expect(inColumn("open")).toContain("wip");
    expect(inColumn("open")).not.toContain("feat: search");
    void rerender;
  });

  it("Issue 看板分 开启 / 已关闭 两列", async () => {
    api.forgeIssues.mockResolvedValue({ items: [], nextCursor: null });
    view(forgeNode({ tab: "issues", view: "board" }));
    await screen.findAllByText("没有条目");
    expect(
      [...document.querySelectorAll("[data-slot=forge-board-column]")].map(
        (el) => el.getAttribute("data-column"),
      ),
    ).toEqual(["open", "closed"]);
  });

  it("搜索串与打开的条目写回节点数据", async () => {
    view(forgeNode());
    await screen.findByText("feat: search");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "label:core" },
    });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(store.updateNodeData).toHaveBeenLastCalledWith(
      "66666666-6666-4666-8666-666666666666",
      { tab: "pulls", query: "label:core", view: "list", open: null },
    );
    fireEvent.click(screen.getByText("feat: search"));
    expect(store.updateNodeData).toHaveBeenLastCalledWith(
      "66666666-6666-4666-8666-666666666666",
      {
        tab: "pulls",
        query: "",
        view: "list",
        open: { kind: "pull", number: 7 },
      },
    );
  });

  it("认不出仓库、没有登录时显示原因而不是空列表", () => {
    target.current = { status: "noRepo", reason: "noRemote" };
    view(forgeNode());
    expect(screen.getByText("这个仓库没有 remote")).toBeTruthy();
    expect(document.querySelector("[data-slot=forge-list]")).toBeNull();
    cleanup();
    target.current = { status: "noLogin", detection: DETECTION };
    view(forgeNode());
    expect(screen.getByText("没找到 git.example.test 的登录")).toBeTruthy();
  });

  it("列表行右键：加到画板建 forgeItem 卡片，持久化里只有仓库坐标与编号", async () => {
    view(forgeNode());
    const row = (await screen.findByText("feat: search")).closest(
      "[data-slot=forge-pull]",
    )!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("加到画板"));
    expect(store.addNode).toHaveBeenCalledTimes(1);
    const [type, options] = store.addNode.mock.calls[0] as unknown as [
      string,
      { data: Record<string, unknown>; title: string },
    ];
    expect(type).toBe("forgeItem");
    expect(options.data).toEqual({
      kind: "forgeItem",
      repo: REPO,
      itemKind: "pull",
      number: 7,
    });
    // 标题是 `仓库名#编号`，不是远端的标题；整个负载里没有令牌、正文与远端数据。
    expect(options.title).toBe("app#7");
    const persisted = JSON.stringify(options);
    for (const leak of ["feat: search", "alice", "token", "body", "failure"])
      expect(persisted).not.toContain(leak);
  });

  it("行右键菜单：打开详情、在浏览器中打开、复制链接", async () => {
    view(forgeNode());
    const row = (await screen.findByText("feat: search")).closest(
      "[data-slot=forge-pull]",
    )!;
    fireEvent.contextMenu(row);
    expect(await screen.findByText("打开详情")).toBeTruthy();
    expect(screen.getByText("在浏览器中打开")).toBeTruthy();
    expect(screen.getByText("复制链接")).toBeTruthy();
    fireEvent.click(screen.getByText("打开详情"));
    expect(store.updateNodeData).toHaveBeenLastCalledWith(
      "66666666-6666-4666-8666-666666666666",
      expect.objectContaining({ open: { kind: "pull", number: 7 } }),
    );
  });

  it("节点数据只有仓库坐标、标签页、搜索串、视图与打开的条目", () => {
    const data = forgeNode().data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      ["kind", "open", "query", "repo", "tab", "view"].sort(),
    );
  });
});
