import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: () => Promise.resolve([]),
    settings: () => Promise.resolve({}),
  },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { useCommandDispatch, type CommandDispatch } from "../app/commands";
import { COMMAND_BY_ID } from "../keybindings";
import { useSessionPage } from "./store";

installDomPolyfills();
afterEach(() => {
  cleanup();
  useSessionPage.setState({ open: false });
});

describe("app.sessions", () => {
  it("命令存在、没有默认键位，派发时切换会话页", () => {
    expect(COMMAND_BY_ID["app.sessions"].defaultKeys).toEqual({
      mac: null,
      other: null,
    });
    let dispatch!: CommandDispatch;
    function Harness() {
      dispatch = useCommandDispatch();
      return null;
    }
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    act(() => dispatch.run("app.sessions"));
    expect(useSessionPage.getState().open).toBe(true);
    act(() => dispatch.run("app.sessions"));
    expect(useSessionPage.getState().open).toBe(false);
  });
});
