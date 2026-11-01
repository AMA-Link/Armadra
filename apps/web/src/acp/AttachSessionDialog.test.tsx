import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentInfo, Workspace } from "@armadra/shared";

const api = vi.hoisted(() => ({ listAgentSessions: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

const create = vi.hoisted(() => vi.fn());
vi.mock("@/canvas/menus/add-menu", () => ({ createAgentNode: create }));

import { AttachSessionDialog } from "./AttachSessionDialog";
import { useAttachSessionStore } from "./attach-session";

const workspace = { id: "w1", rootPath: "/w" } as Workspace;
const agent = { id: "claude", label: "Claude Code" } as AgentInfo;
const context = {
  addNode: vi.fn(),
  position: { x: 0, y: 0 },
  workspace,
  agents: [agent],
};

beforeEach(() => {
  api.listAgentSessions.mockReset();
  create.mockReset();
  useAttachSessionStore.getState().close();
  // cmdk 在 jsdom 里要它。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

function open() {
  useAttachSessionStore.getState().open({ context, agent });
}

describe("AttachSessionDialog", () => {
  it("shows nothing until it is asked to open", () => {
    render(<AttachSessionDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.listAgentSessions).not.toHaveBeenCalled();
  });

  it("lists the agent's own sessions and attaches the one picked", async () => {
    api.listAgentSessions.mockResolvedValue({
      sessions: [
        { sessionId: "s1", cwd: "/w/app", title: "Fix the build" },
        { sessionId: "s2", cwd: "/elsewhere" },
      ],
    });
    render(<AttachSessionDialog />);
    open();
    fireEvent.click(await screen.findByText("Fix the build"));
    expect(api.listAgentSessions).toHaveBeenCalledWith("w1", "claude", {
      cwd: "/w",
    });
    expect(create).toHaveBeenCalledWith(context, agent, expect.any(Function), {
      sessionId: "s1",
      cwd: "/w/app",
    });
    expect(useAttachSessionStore.getState().request).toBeNull();
  });

  it("falls back to the id as the title and leaves out a folder outside the workspace", async () => {
    api.listAgentSessions.mockResolvedValue({
      sessions: [{ sessionId: "s2", cwd: "/elsewhere" }],
    });
    render(<AttachSessionDialog />);
    open();
    fireEvent.click(await screen.findByText("s2"));
    expect(create.mock.calls[0]?.[3]).toEqual({ sessionId: "s2" });
  });

  it("pages on demand", async () => {
    api.listAgentSessions
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s1", cwd: "/w", title: "One" }],
        nextCursor: "c2",
      })
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s3", cwd: "/w", title: "Three" }],
      });
    render(<AttachSessionDialog />);
    open();
    await screen.findByText("One");
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    await screen.findByText("Three");
    expect(api.listAgentSessions).toHaveBeenLastCalledWith("w1", "claude", {
      cwd: "/w",
      cursor: "c2",
    });
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
  });

  it("says so and can retry when the list cannot be read", async () => {
    api.listAgentSessions.mockRejectedValueOnce(new Error("x"));
    render(<AttachSessionDialog />);
    open();
    expect(await screen.findByText("会话没有读到")).toBeTruthy();
    api.listAgentSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "s1", cwd: "/w", title: "Again" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("Again")).toBeTruthy());
  });
});
