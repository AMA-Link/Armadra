import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * 仓库视图（契约 §29.4）单独渲染：按状态筛、翻页、徽标点进来直接是详情。
 * 经抽屉认平台的那几条在 `GithubDrawer.test.tsx`。
 */

const forgeApi = vi.hoisted(() => ({
  forgeIssues: vi.fn(),
  forgeIssue: vi.fn(),
  forgePulls: vi.fn(),
  forgePull: vi.fn(),
  forgeFacets: vi.fn(),
}));

vi.mock("../../api/forge", async (original) => ({
  ...(await original<typeof import("../../api/forge")>()),
  ...forgeApi,
}));

const canvas = vi.hoisted(() => ({ add: vi.fn(() => "id") }));
vi.mock("./add-to-canvas", () => ({
  addForgeItemToCanvas: canvas.add,
  useCanAddToCanvas: () => true,
}));

import type { ForgeIssue } from "../../api/forge";
import { usePreferencesStore } from "../../app/preferences-store";
import { ForgeHosted } from "./ForgeHosted";

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

const issue = (number: number, title: string): ForgeIssue => ({
  number,
  title,
  body: "",
  state: "open",
  author: "alice",
  labels: [],
  commentCount: 0,
  url: "",
  createdAtMs: 1_788_557_900_000,
  updatedAtMs: 1_788_557_900_000,
  closedAtMs: null,
});

function renderHosted(
  focus: { tab: "issues" | "pulls"; number: number; reveal: number } | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ForgeHosted detection={DETECTION} locale="zh-CN" open focus={focus} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const fn of Object.values(forgeApi)) fn.mockReset();
});
afterEach(cleanup);

const page = (items: ForgeIssue[], extra: Record<string, unknown> = {}) => ({
  items,
  nextCursor: null,
  ...extra,
});

describe("仓库视图", () => {
  beforeEach(() => {
    forgeApi.forgeFacets.mockRejectedValue(new Error("501"));
  });

  it("旧 core 只给 nextCursor：下一页用上一页的 nextCursor", async () => {
    forgeApi.forgeIssues
      .mockResolvedValueOnce(page([issue(2, "second")], { nextCursor: "2" }))
      .mockResolvedValueOnce(page([issue(1, "first")]));
    renderHosted(null);
    expect(await screen.findByText("second")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("first")).toBeTruthy();
    expect(forgeApi.forgeIssues).toHaveBeenLastCalledWith(
      REPO,
      "open",
      "2",
      null,
      expect.objectContaining({ page: 2 }),
    );
    expect(
      (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("新 core：开启 / 已关闭计数，页码翻页保留筛选", async () => {
    forgeApi.forgeIssues.mockResolvedValue(
      page([issue(2, "second")], {
        totalCount: 60,
        openCount: 23,
        closedCount: 412,
        page: 1,
        pageCount: 3,
      }),
    );
    renderHosted(null);
    expect(await screen.findByText("second")).toBeTruthy();
    expect(screen.getByText("开启 23")).toBeTruthy();
    expect(screen.getByText("已关闭 412")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "label:core" },
    });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    await waitFor(() =>
      expect(forgeApi.forgeIssues).toHaveBeenLastCalledWith(
        REPO,
        "open",
        null,
        null,
        expect.objectContaining({ q: "label:core", page: 1 }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "3" }));
    await waitFor(() =>
      expect(forgeApi.forgeIssues).toHaveBeenLastCalledWith(
        REPO,
        "open",
        null,
        null,
        expect.objectContaining({ q: "label:core", page: 3 }),
      ),
    );
  });

  it("换状态重新取", async () => {
    forgeApi.forgeIssues.mockResolvedValue(page([]));
    renderHosted(null);
    expect(await screen.findByText("没有条目")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /已关闭/ }));
    await waitFor(() =>
      expect(forgeApi.forgeIssues).toHaveBeenCalledWith(
        REPO,
        "closed",
        null,
        null,
        expect.anything(),
      ),
    );
  });

  it("空查询不额外发请求；输入后停手才查，内容没变不重复查", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      forgeApi.forgeIssues.mockResolvedValue(page([]));
      renderHosted(null);
      await screen.findByText("没有条目");
      expect(forgeApi.forgeIssues).toHaveBeenCalledTimes(1);
      const box = screen.getByRole("searchbox");
      fireEvent.change(box, { target: { value: "   " } });
      await vi.advanceTimersByTimeAsync(800);
      expect(forgeApi.forgeIssues).toHaveBeenCalledTimes(1);
      fireEvent.change(box, { target: { value: "sync" } });
      await vi.advanceTimersByTimeAsync(800);
      await waitFor(() =>
        expect(forgeApi.forgeIssues).toHaveBeenCalledTimes(2),
      );
      expect(forgeApi.forgeIssues).toHaveBeenLastCalledWith(
        REPO,
        "open",
        null,
        null,
        expect.objectContaining({ q: "sync" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("筛选下拉与搜索串双向同步", async () => {
    forgeApi.forgeIssues.mockResolvedValue(
      page([{ ...issue(2, "second"), labels: ["core", "web"] }]),
    );
    renderHosted(null);
    await screen.findByText("second");
    const box = screen.getByRole("searchbox") as HTMLInputElement;
    // 下拉 → 搜索串
    const label = screen.getByRole("button", { name: "标签" });
    fireEvent.keyDown(label, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "core" }),
    );
    await waitFor(() => expect(box.value).toBe("label:core"));
    // 多选的菜单选完不收起：Esc 关掉
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    // 搜索串 → 下拉
    fireEvent.change(box, { target: { value: "author:alice" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "作者 · alice" }),
    ).toBeTruthy();
  });

  it("平台不支持的限定词有提示", async () => {
    forgeApi.forgeIssues.mockResolvedValue(
      page([], { unsupported: ["review:approved"] }),
    );
    renderHosted(null);
    expect(await screen.findByText(/review:approved/)).toBeTruthy();
  });

  it("徽标点进来的条目直接是详情，返回后才取列表", async () => {
    forgeApi.forgeIssue.mockResolvedValue({
      ...issue(9, "pinned"),
      labels: ["bug"],
      body: "full text",
    });
    forgeApi.forgeIssues.mockResolvedValue(page([]));
    renderHosted({ tab: "issues", number: 9, reveal: 1 });
    expect(await screen.findByText("full text")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    expect(forgeApi.forgeIssues).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("返回"));
    await waitFor(() => expect(forgeApi.forgeIssues).toHaveBeenCalled());
  });

  it("详情头部「加到画板」放一张卡片：仓库坐标、种类与编号", async () => {
    forgeApi.forgeIssue.mockResolvedValue({ ...issue(9, "pinned"), body: "x" });
    forgeApi.forgeIssues.mockResolvedValue(page([]));
    canvas.add.mockClear();
    renderHosted({ tab: "issues", number: 9, reveal: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "加到画板" }));
    expect(canvas.add).toHaveBeenCalledWith(REPO, "issue", 9);
  });
});
