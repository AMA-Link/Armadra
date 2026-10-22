import { afterEach, describe, expect, it, vi } from "vitest";

import { agentFixture } from "../agent/fixture";
import type { CoreContext } from "../main";
import { launchInSession } from "./node-launch";
import type { TerminalManager } from "./manager";

// #462：节点体是会话时间线时没有终端表面，启动行由 core 敲。
describe("launchInSession", () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const fixture = agentFixture();
    const nodeId = fixture.agentNode("Planner");
    const writes: string[] = [];
    let last: number | undefined;
    const manager = {
      observedActivity: () => ({ lastOutputAt: last }),
      input: async (_id: string, _generation: number, text: string) => {
        writes.push(text);
      },
    } as unknown as TerminalManager;
    const context = {
      db: { database: fixture.database },
      dataDir: fixture.collab.dataDir,
      log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as unknown as CoreContext;
    return {
      fixture,
      nodeId,
      writes,
      manager,
      context,
      quiet: () => (last = 0),
    };
  }

  it("types the launch line once the prompt has gone quiet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { fixture, nodeId, writes, manager, context } = setup();
    launchInSession(context, manager, {
      sessionId: "s",
      generation: 1,
      nodeId,
      agentId: "claude",
      shell: "/bin/sh",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([]);
    // 没有输出：冷启动上限到了照敲。
    await vi.advanceTimersByTimeAsync(3_500);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/claude/);
    expect(writes[0]).toMatch(/\r$/);
    fixture.close();
  });

  it("writes nothing when a person has half-typed input", async () => {
    vi.useFakeTimers();
    const { fixture, nodeId, writes, context } = setup();
    const manager = {
      observedActivity: () => ({ pending: true }),
      input: async (_i: string, _g: number, text: string) => {
        writes.push(text);
      },
    } as unknown as TerminalManager;
    launchInSession(context, manager, {
      sessionId: "s",
      generation: 1,
      nodeId,
      agentId: "claude",
      shell: undefined,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual([]);
    fixture.close();
  });
});
