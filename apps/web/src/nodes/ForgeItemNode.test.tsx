import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  addNode: vi.fn(),
  setPanel: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

const api = vi.hoisted(() => ({
  forgeIssue: vi.fn(),
  forgePull: vi.fn(),
  forgePullChecks: vi.fn(),
  detectForge: vi.fn(),
}));
vi.mock("../api/forge", async (original) => ({
  ...(await original<typeof import("../api/forge")>()),
  ...api,
}));

import { forgeIssueExtSchema, forgePullExtSchema } from "../api/forge";
import { usePreferencesStore } from "@/app/preferences-store";
import { useGithubFocus } from "@/panels/github/open";
import { ForgeItemNode } from "./ForgeItemNode";

const REPO = { host: "git.example.test", owner: "acme", name: "app" };
const AT = 1_788_557_900_000;

const card = (itemKind: "issue" | "pull", number: number) =>
  ({
    id: "77777777-7777-4777-8777-777777777777",
    boardId: "b1",
    type: "forgeItem",
    title: `app#${number}`,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "forgeItem", repo: REPO, itemKind, number },
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
      <ForgeItemNode
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
  for (const fn of Object.values(api)) fn.mockReset();
  api.detectForge.mockResolvedValue({ forge: "gitea" });
  api.forgePullChecks.mockResolvedValue({
    headSha: "a".repeat(40),
    rollup: "failure",
    checks: [
      { name: "a", state: "success", url: null },
      { name: "b", state: "failure", url: null },
    ],
  });
  useGithubFocus.setState({ number: null, target: null, reveal: 0 });
  store.setPanel.mockClear();
});
afterEach(cleanup);

describe("画布单条卡片（#934）", () => {
  it("PR：状态胶囊、条目行、检查汇总与审查结论；点条目在面板打开详情", async () => {
    api.forgePull.mockResolvedValue(
      forgePullExtSchema.parse({
        number: 7,
        title: "feat: search",
        body: "",
        state: "open",
        draft: false,
        author: "alice",
        baseRef: "main",
        headRef: "x",
        headSha: "a".repeat(40),
        mergeable: "mergeable",
        url: "",
        createdAtMs: AT,
        updatedAtMs: AT,
        mergedAtMs: null,
        reviewDecision: "changesRequested",
      }),
    );
    view(card("pull", 7));
    expect(await screen.findByText("feat: search")).toBeTruthy();
    expect(screen.getByText("acme/app#7")).toBeTruthy();
    expect(document.querySelector("[data-slot=forge-state]")?.textContent).toBe(
      "开启",
    );
    expect(await screen.findByText("检查 1 / 2 通过")).toBeTruthy();
    expect(
      document.querySelector("[data-slot=forge-item-review]")?.textContent,
    ).toBe("需要修改");
    await waitFor(() => expect(api.detectForge).toHaveBeenCalled());
    fireEvent.click(screen.getByText("feat: search"));
    expect(store.setPanel).toHaveBeenCalledWith("github", "drawer");
    const focus = useGithubFocus.getState();
    expect(focus.tab).toBe("pulls");
    expect(focus.number).toBe(7n);
    expect(focus.target).toMatchObject({ forge: "gitea", ...REPO });
  });

  it("Issue：没有检查与审查行，点开是 Issues 页签", async () => {
    api.forgeIssue.mockResolvedValue(
      forgeIssueExtSchema.parse({
        number: 3,
        title: "crash",
        body: "",
        state: "closed",
        author: "bob",
        labels: [],
        commentCount: 0,
        url: "",
        createdAtMs: AT,
        updatedAtMs: AT,
        closedAtMs: AT,
      }),
    );
    view(card("issue", 3));
    fireEvent.click(await screen.findByText("crash"));
    expect(api.forgePullChecks).not.toHaveBeenCalled();
    expect(document.querySelector("[data-slot=forge-item-review]")).toBeNull();
    expect(useGithubFocus.getState().tab).toBe("issues");
  });

  it("远端读不出来时只显示原因，节点数据仍只有坐标与编号", async () => {
    api.forgePull.mockRejectedValue(new Error("boom"));
    const node = card("pull", 9);
    view(node);
    expect(await screen.findByText("请求失败")).toBeTruthy();
    expect(Object.keys(node.data as object).sort()).toEqual(
      ["itemKind", "kind", "number", "repo"].sort(),
    );
  });
});
