import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GithubReferenceKind, githubExternalReference } from "../../api/github";

/**
 * 代码托管面板（契约 §29）：三个平台同一面、只读。远端地址经 `forge.resolve`
 * 认平台；列表与详情都走 `forge.*`，从不走 GitHub 客户端。
 */

const store = vi.hoisted(() => ({
  panels: { github: "drawer" as "drawer" | "closed" },
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  setPanel: vi.fn(),
}));

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  client: null as unknown,
  connect: vi.fn(async () => {}),
  reset: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("@/host/github-session", () => {
  const useGithubSession = <T,>(selector: (state: typeof session) => T) =>
    selector(session);
  useGithubSession.getState = () => session;
  return { useGithubSession, GITHUB_CAPABILITY: "github.issues.v1" };
});

const forgeApi = vi.hoisted(() => ({
  resolveForge: vi.fn(),
  detectForge: vi.fn(),
  forgeIssues: vi.fn(),
  forgeIssue: vi.fn(),
  forgePulls: vi.fn(),
  forgePull: vi.fn(),
}));

vi.mock("../../api/forge", async (original) => ({
  ...(await original<typeof import("../../api/forge")>()),
  ...forgeApi,
}));

import { RuntimeRequestError } from "@/api/request";
import { usePreferencesStore } from "@/app/preferences-store";
import type { ForgeIssue, ForgePull } from "../../api/forge";
import { GithubDrawer } from "./GithubDrawer";
import { openGithubPanel, useGithubFocus } from "./open";
import { referenceTarget } from "./references";

const AT = 1_788_557_900_000;

const forgeIssue = (number: number, title: string): ForgeIssue => ({
  number,
  title,
  body: "",
  state: "open",
  author: "alice",
  labels: ["bug"],
  commentCount: 2,
  url: `https://git.example.test/acme/app/issues/${number}`,
  createdAtMs: AT,
  updatedAtMs: AT,
  closedAtMs: null,
});

const forgePull = (number: number, title: string): ForgePull => ({
  number,
  title,
  body: "",
  state: "open",
  draft: false,
  author: "alice",
  baseRef: "main",
  headRef: "feature/login",
  headSha: "d".repeat(40),
  mergeable: "mergeable",
  url: `https://git.example.test/acme/app/pulls/${number}`,
  createdAtMs: AT,
  updatedAtMs: AT,
  mergedAtMs: null,
  autoMerge: false,
  fromFork: false,
});

/** 一份识别结果（§29.2）。 */
function detection(
  forge: "github" | "gitea" | "gitlab" | null,
  overrides: Record<string, unknown> = {},
) {
  const host = (overrides.host as string) ?? "git.example.test";
  return {
    repository: { host, owner: "acme", name: "app" },
    forge,
    source: forge === null ? null : forge === "github" ? "github" : "config",
    configKey: forge === null || forge === "github" ? null : host,
    apiBase: forge === null ? null : `https://${host}/api/v4`,
    webUrl: forge === null ? null : `https://${host}/acme/app`,
    credential: forge !== null,
    accountLogin: forge === null ? null : "bot",
    ...overrides,
  };
}

function ready() {
  const api = { workspaceId: "workspace-1" };
  session.state = { status: "ready", client: api, canWrite: true };
  session.client = api;
}

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubDrawer />
    </QueryClientProvider>,
  );
}

async function resolveRemote(url: string) {
  const input = document.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByText("解析仓库"));
}

/** Radix 的页签在 mousedown 上换页，不是 click。 */
function selectTab(label: string) {
  fireEvent.mouseDown(screen.getByText(label), { button: 0 });
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  store.panels.github = "drawer";
  store.setPanel.mockClear();
  session.connect.mockClear();
  session.state = { status: "idle" };
  session.client = null;
  useGithubFocus.setState({
    tab: "issues",
    number: null,
    target: null,
    reveal: 0,
  });
  for (const fn of Object.values(forgeApi)) fn.mockReset();
  forgeApi.forgeIssues.mockResolvedValue({ items: [], nextCursor: null });
  forgeApi.forgePulls.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(cleanup);

describe("可用性", () => {
  it("Host 用不了时只说原因并给去设置的入口", async () => {
    session.state = { status: "blocked", reason: "signedOut" };
    renderDrawer();
    expect(await screen.findByText("这台设备还没有与 Host 配对")).toBeTruthy();
    expect(screen.queryByText("解析仓库")).toBeNull();
    fireEvent.click(screen.getByText("前往设置"));
    expect(store.setPanel).toHaveBeenCalledWith("settings", true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("devices");
  });

  it("没有 GitHub 凭据不挡整页：GitHub 仓库说没有令牌并指去代码托管设置", async () => {
    const api = { workspaceId: "workspace-1" };
    session.state = { status: "blocked", reason: "noCredential" };
    session.client = api;
    forgeApi.resolveForge.mockResolvedValue(
      detection("github", { host: "github.com", credential: false }),
    );
    renderDrawer();
    await resolveRemote("https://github.com/acme/app.git");
    expect(await screen.findByText("还没有这个平台的令牌")).toBeTruthy();
    fireEvent.click(screen.getByText("前往设置 → 代码托管"));
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("forge");
    expect(forgeApi.forgeIssues).not.toHaveBeenCalled();
  });

  it("认不出的远端说明白并指去设置", async () => {
    ready();
    forgeApi.resolveForge.mockResolvedValue(detection(null));
    renderDrawer();
    await resolveRemote("https://code.example.test/acme/app.git");
    expect(await screen.findByText("这个远端没有识别出托管平台")).toBeTruthy();
    expect(forgeApi.forgeIssues).not.toHaveBeenCalled();
  });

  it("没有托管平台域的旧 core：照实说，不退回别的面", async () => {
    ready();
    forgeApi.resolveForge.mockRejectedValue(
      new RuntimeRequestError(501, "not implemented", "not_implemented"),
    );
    renderDrawer();
    await resolveRemote("https://github.com/acme/app.git");
    expect(await screen.findByText("这个 Host 没有托管平台服务")).toBeTruthy();
  });
});

describe("仓库、issue 与 PR", () => {
  it("GitHub：仓库行、issue 列表与详情都走 forge.*", async () => {
    ready();
    forgeApi.resolveForge.mockResolvedValue(
      detection("github", { host: "github.com" }),
    );
    forgeApi.forgeIssues.mockResolvedValue({
      items: [forgeIssue(7, "Crash on start")],
      nextCursor: null,
    });
    forgeApi.forgeIssue.mockResolvedValue({
      ...forgeIssue(7, "Crash on start"),
      body: "Steps to reproduce",
    });
    renderDrawer();
    await resolveRemote("https://github.com/acme/app.git");
    expect(await screen.findByText("Crash on start")).toBeTruthy();
    expect(
      document.querySelector("[data-slot=forge-repository]")?.textContent,
    ).toBe("acme/app");
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(forgeApi.forgeIssues).toHaveBeenCalledWith(
      { host: "github.com", owner: "acme", name: "app" },
      "open",
      null,
    );
    fireEvent.click(screen.getByText("Crash on start"));
    expect(await screen.findByText("Steps to reproduce")).toBeTruthy();
    // 只读：没有关闭、新建、移动之类的写控件。
    expect(screen.queryByText("关闭")).toBeNull();
    expect(screen.queryByText("新建")).toBeNull();
  });

  it("GitLab：叫 Merge requests，详情只读，没有合并与检出", async () => {
    ready();
    forgeApi.resolveForge.mockResolvedValue(detection("gitlab"));
    forgeApi.forgePulls.mockResolvedValue({
      items: [forgePull(12, "Login rework")],
      nextCursor: null,
    });
    forgeApi.forgePull.mockResolvedValue({
      ...forgePull(12, "Login rework"),
      body: "Split the page",
    });
    renderDrawer();
    await resolveRemote("https://git.example.test/acme/app.git");
    await screen.findByText("Merge requests");
    selectTab("Merge requests");
    fireEvent.click(await screen.findByText("Login rework"));
    expect(await screen.findByText("Split the page")).toBeTruthy();
    expect(screen.getByText("feature/login → main")).toBeTruthy();
    expect(document.querySelector("[data-slot=forge-merge]")).toBeNull();
    expect(screen.queryByText("合并")).toBeNull();
  });

  it("GitLab 子组：仓库行显示完整命名空间，列表按它取", async () => {
    ready();
    const nested = {
      host: "git.example.test",
      owner: "platform/web",
      name: "app",
    };
    forgeApi.resolveForge.mockResolvedValue(
      detection("gitlab", { repository: nested }),
    );
    renderDrawer();
    await resolveRemote("git@git.example.test:platform/web/app.git");
    await waitFor(() =>
      expect(forgeApi.forgeIssues).toHaveBeenCalledWith(nested, "open", null),
    );
    expect(
      document.querySelector("[data-slot=forge-repository]")?.textContent,
    ).toBe("platform/web/app");
  });

  it("令牌缺范围时照实说", async () => {
    ready();
    forgeApi.resolveForge.mockResolvedValue(detection("gitlab"));
    forgeApi.forgeIssues.mockRejectedValue(
      new RuntimeRequestError(403, "这个令牌缺少所需的范围", "forge_scope"),
    );
    renderDrawer();
    await resolveRemote("https://git.example.test/acme/app.git");
    expect(
      await screen.findByText("令牌缺少所需的范围，换一个范围足够的令牌"),
    ).toBeTruthy();
  });
});

describe("画布上的连接徽标", () => {
  it("GitHub 与 GitLab 的连接都带仓库，点进来直接是那一条的详情", async () => {
    ready();
    const nested = {
      host: "git.example.test",
      owner: "platform/web",
      name: "app",
    };
    forgeApi.detectForge.mockResolvedValue(
      detection("gitlab", { repository: nested }),
    );
    forgeApi.forgePull.mockResolvedValue(forgePull(31, "Subgroup change"));
    const target = referenceTarget(
      githubExternalReference({
        forge: "gitlab",
        repository: { ...nested, apiBase: "https://git.example.test/api/v4" },
        kind: GithubReferenceKind.PULL_REQUEST,
        number: 31n,
      }),
    );
    expect(target).toEqual({ forge: "gitlab", ...nested });
    expect(
      referenceTarget(
        githubExternalReference({
          forge: "github",
          repository: {
            owner: "acme",
            name: "app",
            apiBase: "https://api.github.com",
            host: "github.com",
          },
          number: 1n,
        }),
      ),
    ).toEqual({
      forge: "github",
      host: "github.com",
      owner: "acme",
      name: "app",
    });
    openGithubPanel("pulls", 31n, target);
    expect(store.setPanel).toHaveBeenCalledWith("github", "drawer");
    renderDrawer();
    expect(await screen.findByText("Subgroup change")).toBeTruthy();
    expect(forgeApi.detectForge).toHaveBeenCalledWith(nested);
    expect(forgeApi.resolveForge).not.toHaveBeenCalled();
    expect(forgeApi.forgePull).toHaveBeenCalledWith(nested, 31);
    expect(forgeApi.forgePulls).not.toHaveBeenCalled();
  });
});
