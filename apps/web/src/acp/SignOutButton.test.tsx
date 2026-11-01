import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

const api = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

const store = vi.hoisted(() => ({
  workspace: { id: "w1", rootPath: "/repo" } as null | {
    id: string;
    rootPath: string;
  },
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { SignOutButton, canSignOut } from "./SignOutButton";

const agent = (logout: boolean | undefined): AgentInfo =>
  ({
    id: "claude",
    acp: {
      support: "official",
      program: "claude-agent-acp",
      installed: true,
      resume: "load",
      ...(logout === undefined
        ? {}
        : {
            capabilities: {
              load: true,
              resume: true,
              list: false,
              close: false,
              logout,
              image: false,
              audio: false,
              embeddedContext: false,
              mcpHttp: false,
              mcpSse: false,
              authMethods: [],
            },
          }),
    },
  }) as unknown as AgentInfo;

beforeEach(() => {
  api.logout.mockReset().mockResolvedValue(undefined);
  store.workspace = { id: "w1", rootPath: "/repo" };
});
afterEach(cleanup);

describe("SignOutButton", () => {
  it("is only offered when core says the agent can sign out", () => {
    expect(canSignOut(agent(true))).toBe(true);
    expect(canSignOut(agent(false))).toBe(false);
    expect(canSignOut(agent(undefined))).toBe(false);
    const hidden = render(<SignOutButton agent={agent(false)} />);
    expect(hidden.container.textContent).toBe("");
    hidden.unmount();
    render(<SignOutButton agent={agent(true)} />);
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
  });

  it("asks core to sign the agent out of this workspace's machine", async () => {
    render(<SignOutButton agent={agent(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() =>
      expect(api.logout).toHaveBeenCalledWith("w1", "claude"),
    );
  });
});
