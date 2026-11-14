import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { GithubReferenceKind, githubExternalReference } from "../../api/github";

/** 画布徽标：悬停弹出面板列表里的同一行，点击仍打开面板；框头部带检查汇总。 */

const refs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("./references", async (original) => ({
  ...(await original<typeof import("./references")>()),
  useGithubReferences: () => refs.list,
}));
const open = vi.hoisted(() => ({ openGithubPanel: vi.fn() }));
vi.mock("./open", () => open);
vi.mock("@/store/canvas-store", () => {
  const state = { workspace: { id: "ws-1" } };
  const useCanvasStore = <T,>(selector: (s: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});
const forgeApi = vi.hoisted(() => ({
  forgePull: vi.fn(),
  forgeIssue: vi.fn(),
  forgePullChecks: vi.fn(),
}));
vi.mock("../../api/forge", async (original) => ({
  ...(await original<typeof import("../../api/forge")>()),
  ...forgeApi,
}));

import { usePreferencesStore } from "../../app/preferences-store";
import { GithubReferenceBadge } from "./GithubReferenceBadge";

const reference = githubExternalReference({
  referenceId: "r1",
  forge: "gitea",
  kind: GithubReferenceKind.PULL_REQUEST,
  number: 12n,
  repository: {
    host: "git.example.test",
    owner: "acme",
    name: "app",
    apiBase: "https://git.example.test/api/v1",
  },
});

function renderBadge(checks: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GithubReferenceBadge nodeId="n1" checks={checks} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  refs.list = [reference];
  forgeApi.forgePull.mockReset().mockResolvedValue({
    number: 12,
    title: "Login rework",
    body: "",
    state: "open",
    draft: true,
    author: "alice",
    baseRef: "main",
    headRef: "f",
    headSha: "a",
    mergeable: "mergeable",
    url: "",
    createdAtMs: 1,
    updatedAtMs: 1_788_557_900_000,
    mergedAtMs: null,
    autoMerge: false,
    fromFork: false,
  });
  forgeApi.forgePullChecks.mockReset().mockResolvedValue({
    headSha: "a",
    rollup: "pending",
    checks: [
      { name: "lint", state: "success", url: null },
      { name: "test", state: "pending", url: null },
    ],
  });
  open.openGithubPanel.mockReset();
});
afterEach(cleanup);

describe("GithubReferenceBadge", () => {
  it("悬停才取条目并弹出同一行；点击徽标打开面板", async () => {
    renderBadge(false);
    expect(forgeApi.forgePull).not.toHaveBeenCalled();
    const badge = screen.getByRole("button");
    await act(async () => {
      fireEvent.pointerEnter(badge, { pointerType: "mouse" });
      fireEvent.pointerMove(badge, { pointerType: "mouse" });
    });
    expect(await screen.findByText("Login rework")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();
    expect(forgeApi.forgePull).toHaveBeenCalled();
    fireEvent.click(badge);
    expect(open.openGithubPanel).toHaveBeenCalledWith(
      "pulls",
      12n,
      expect.objectContaining({ host: "git.example.test" }),
    );
  });

  it("绑定 PR 的框头部：徽标旁有紧凑检查汇总；普通徽标没有", async () => {
    const { unmount } = renderBadge(true);
    expect(await screen.findByText(/1\/2/)).toBeTruthy();
    unmount();
    forgeApi.forgePullChecks.mockClear();
    renderBadge(false);
    expect(screen.queryByText(/1\/2/)).toBeNull();
    expect(forgeApi.forgePullChecks).not.toHaveBeenCalled();
  });
});
