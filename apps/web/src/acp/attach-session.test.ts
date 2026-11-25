import { describe, expect, it } from "vitest";
import type { AgentInfo } from "@armadra/shared";

import { attachCwd, attachable } from "./attach-session";
import { mergeSessions } from "./use-agent-sessions";

const agent = (acp: unknown): Pick<AgentInfo, "acp"> =>
  ({ acp }) as unknown as Pick<AgentInfo, "acp">;

describe("attachable", () => {
  it("needs the adapter installed and the list capability reported", () => {
    const base = { support: "official", program: "x", resume: "load" };
    expect(
      attachable(
        agent({ ...base, installed: true, capabilities: { list: true } }),
      ),
    ).toBe(true);
    expect(
      attachable(
        agent({ ...base, installed: true, capabilities: { list: false } }),
      ),
    ).toBe(false);
    expect(
      attachable(
        agent({ ...base, installed: false, capabilities: { list: true } }),
      ),
    ).toBe(false);
    expect(attachable(agent({ ...base, installed: true }))).toBe(false);
    expect(attachable(agent(undefined))).toBe(false);
  });
});

describe("attachCwd", () => {
  it("keeps a session folder inside the workspace and drops one outside", () => {
    expect(attachCwd({ cwd: "/w/app" }, "/w")).toBe("/w/app");
    expect(attachCwd({ cwd: "/w/" }, "/w")).toBe("/w");
    expect(attachCwd({ cwd: "/w2/app" }, "/w")).toBeUndefined();
    expect(attachCwd({ cwd: "/other" }, "/w")).toBeUndefined();
    expect(attachCwd({ cwd: "" }, "/w")).toBeUndefined();
    // 分隔符与盘符大小写不同也认得，返回原样的目录。
    expect(attachCwd({ cwd: "C:\\w\\app" }, "C:/w")).toBe("C:\\w\\app");
    expect(attachCwd({ cwd: "c:\\W\\app\\" }, "C:\\w")).toBe("c:\\W\\app");
    expect(attachCwd({ cwd: "C:\\w2\\app" }, "C:\\w")).toBeUndefined();
    expect(attachCwd({ cwd: "/W/app" }, "/w")).toBeUndefined();
  });
});

describe("mergeSessions", () => {
  it("appends a page without repeating a session", () => {
    const a = { sessionId: "a", cwd: "/w" };
    const b = { sessionId: "b", cwd: "/w" };
    expect(mergeSessions([a], [a, b])).toEqual([a, b]);
  });
});
