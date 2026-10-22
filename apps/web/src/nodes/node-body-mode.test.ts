import { afterEach, describe, expect, it } from "vitest";

import {
  initialBodyMode,
  nodeBodyMode,
  useNodeBodyStore,
} from "./node-body-mode";
import { preferredView } from "../acp/driver";

afterEach(() => useNodeBodyStore.setState({ modes: {} }));

describe("node body default", () => {
  it("follows agent.view until the user switches it on this device", () => {
    expect(initialBodyMode({ view: "session" })).toBe("session");
    expect(initialBodyMode({})).toBe("terminal");
    expect(initialBodyMode(undefined)).toBe("terminal");

    const agent = { view: "session" as const };
    expect(nodeBodyMode("n1", agent)).toBe("session");
    useNodeBodyStore.getState().set("n1", "terminal");
    expect(nodeBodyMode("n1", agent)).toBe("terminal");
    // 偏好之后怎么变，手动选择都不被覆盖。
    expect(nodeBodyMode("n1", { view: "session" })).toBe("terminal");
  });
});

describe("preferredView", () => {
  const claude = { id: "claude", acp: { installed: false } } as never;
  const grok = { id: "grok" } as never;
  const installed = { id: "claude", acp: { installed: true } } as never;

  it("session preference", () => {
    expect(preferredView(installed, "acp")).toEqual({ driver: "acp" });
    expect(preferredView(claude, "acp")).toEqual({
      driver: "terminal",
      view: "session",
    });
    expect(preferredView(grok, "acp")).toEqual({ driver: "terminal" });
  });

  it("terminal preference", () => {
    expect(preferredView(installed, "terminal")).toEqual({
      driver: "terminal",
    });
    expect(preferredView(claude, "terminal")).toEqual({ driver: "terminal" });
  });
});
