import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  session: vi.fn(),
  get: vi.fn(),
  log: vi.fn(),
  guest: null as object | null,
}));
vi.mock("@/api/client", () => ({
  clientFor: () => ({
    identity: { session: calls.session },
    terminals: { get: calls.get },
    acp: { log: calls.log },
  }),
}));
vi.mock("@/sources/hosted", () => ({
  hostedRelay: () => ({ guest: () => calls.guest }),
}));
// xterm 在 jsdom 里画不出来；这里只看页面挑了哪一种视图。
vi.mock("./ReadOnlyTerminal", () => ({
  ReadOnlyTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal" data-session={sessionId} />
  ),
}));

import { LOCAL_SOURCE_ID } from "@/api/source";
import { useCanvasStore } from "@/store/canvas-store";
import { SharedSessionHost } from "./SharedSessionHost";
import SharedSessionPage from "./SharedSessionPage";
import { sessionShareOf, useSharedSessionView } from "./sessions";

/** 会话分享的访客入口与只读查看页（#309、#253，契约 §79）。 */

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

function row(kind: string) {
  return {
    id: SESSION,
    workspaceId: WS,
    cwd: "/tmp",
    shell: "/bin/zsh",
    agentId: null,
    command: null,
    status: "running",
    exitCode: null,
    pid: 1,
    createdAt: "2026-10-12T00:00:00Z",
    endedAt: null,
    kind,
  };
}

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  calls.session.mockReset();
  calls.get.mockReset();
  calls.log.mockReset();
  calls.guest = null;
  useSharedSessionView.getState().close();
  useCanvasStore.setState({ workspace: null });
});
afterEach(cleanup);

describe("sessionShareOf", () => {
  it("只限会话的终端读授权、没有画布：会话查看者", () => {
    expect(
      sessionShareOf([
        { permission: "events:read", workspaceId: WS },
        { permission: "terminal:read", workspaceId: WS, resourceId: SESSION },
        { permission: "terminal:read", workspaceId: WS, resourceId: SESSION },
      ]),
    ).toEqual({
      sessions: [{ workspaceId: WS, sessionId: SESSION }],
      sessionOnly: true,
    });
  });

  it("有画布的人不是只看会话；不带资源的授权不算会话", () => {
    expect(
      sessionShareOf([
        { permission: "canvas:read", workspaceId: "w2" },
        { permission: "terminal:read", workspaceId: WS, resourceId: SESSION },
      ]).sessionOnly,
    ).toBe(false);
    expect(
      sessionShareOf([{ permission: "terminal:read", workspaceId: WS }]),
    ).toEqual({ sessions: [], sessionOnly: false });
  });
});

describe("SharedSessionPage", () => {
  const target = {
    sourceId: LOCAL_SOURCE_ID,
    workspaceId: WS,
    sessionId: SESSION,
  };

  it("终端会话：只读标记、只读附着，没有输入框", async () => {
    calls.get.mockResolvedValue(row("terminal"));
    render(wrap(<SharedSessionPage target={target} />));
    expect(
      (await screen.findByTestId("terminal")).getAttribute("data-session"),
    ).toBe(SESSION);
    expect(screen.getByText("只读")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    // 没给 onClose（浏览器里只有这一页的访客）就没有关闭按钮。
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("ACP 会话：画转录，不画输入框与审批按钮", async () => {
    calls.get.mockResolvedValue(row("acp"));
    calls.log.mockResolvedValue({
      entries: [
        {
          role: "user",
          blocks: [{ type: "text", text: "hello there" }],
          endOffset: 1,
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "general kenobi" }],
          endOffset: 2,
        },
      ],
      endOffset: 2,
    });
    const close = vi.fn();
    render(wrap(<SharedSessionPage target={target} onClose={close} />));
    expect(await screen.findByText("general kenobi")).toBeTruthy();
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("terminal")).toBeNull();
    screen.getByRole("button", { name: "关闭" }).click();
    expect(close).toHaveBeenCalled();
  });
});

describe("SharedSessionHost", () => {
  it("浏览器里按会话链接进来的访客：落到第一条会话，不给关闭", async () => {
    calls.guest = { role: "viewer" };
    calls.session.mockResolvedValue({
      scopes: [
        { permission: "events:read", workspaceId: WS, executionHostId: "" },
        {
          permission: "terminal:read",
          workspaceId: WS,
          executionHostId: "",
          resourceId: SESSION,
        },
      ],
    });
    calls.get.mockResolvedValue(row("terminal"));
    render(wrap(<SharedSessionHost />));
    await waitFor(() =>
      expect(useSharedSessionView.getState().target).toEqual({
        sourceId: LOCAL_SOURCE_ID,
        workspaceId: WS,
        sessionId: SESSION,
      }),
    );
    expect(await screen.findByTestId("terminal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("不是访客的页面不问身份会话；打开工作空间时让位给画布", async () => {
    render(wrap(<SharedSessionHost />));
    expect(calls.session).not.toHaveBeenCalled();
    act(() =>
      useSharedSessionView
        .getState()
        .open({ sourceId: "src-1", workspaceId: WS, sessionId: SESSION }),
    );
    expect(useSharedSessionView.getState().target).not.toBeNull();
    act(() =>
      useCanvasStore.setState({
        workspace: { id: "w1" } as never,
      }),
    );
    expect(useSharedSessionView.getState().target).toBeNull();
  });
});
