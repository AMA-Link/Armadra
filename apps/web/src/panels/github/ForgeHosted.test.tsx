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
}));

vi.mock("../../api/forge", async (original) => ({
  ...(await original<typeof import("../../api/forge")>()),
  ...forgeApi,
}));

import type { ForgeIssue } from "../../api/forge";
import { usePreferencesStore } from "../../app/preferences-store";
import { chooseOption } from "../../app/test-harness";
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

describe("仓库视图", () => {
  it("列表翻页：下一页用上一页的 nextCursor", async () => {
    forgeApi.forgeIssues
      .mockResolvedValueOnce({ items: [issue(2, "second")], nextCursor: "2" })
      .mockResolvedValueOnce({ items: [issue(1, "first")], nextCursor: null });
    renderHosted(null);
    expect(await screen.findByText("second")).toBeTruthy();
    fireEvent.click(screen.getByText("加载更多"));
    expect(await screen.findByText("first")).toBeTruthy();
    expect(forgeApi.forgeIssues).toHaveBeenLastCalledWith(REPO, "open", "2");
    expect(screen.queryByText("加载更多")).toBeNull();
  });

  it("换状态重新取", async () => {
    forgeApi.forgeIssues.mockResolvedValue({ items: [], nextCursor: null });
    renderHosted(null);
    expect(await screen.findByText("没有条目")).toBeTruthy();
    await chooseOption(screen.getByRole("combobox"), "已关闭");
    await waitFor(() =>
      expect(forgeApi.forgeIssues).toHaveBeenCalledWith(REPO, "closed", null),
    );
  });

  it("徽标点进来的条目直接是详情，返回后才取列表", async () => {
    forgeApi.forgeIssue.mockResolvedValue({
      ...issue(9, "pinned"),
      labels: ["bug"],
      body: "full text",
    });
    forgeApi.forgeIssues.mockResolvedValue({ items: [], nextCursor: null });
    renderHosted({ tab: "issues", number: 9, reveal: 1 });
    expect(await screen.findByText("full text")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    expect(forgeApi.forgeIssues).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("返回"));
    await waitFor(() => expect(forgeApi.forgeIssues).toHaveBeenCalled());
  });
});
