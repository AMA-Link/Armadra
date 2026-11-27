import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture } from "../agent/fixture";
import type { TerminalSession } from "../terminal/manager";
import { acpSpawnOnce } from "./routes";

/** 依赖编排与页面挂载同时替一个 ACP 节点起会话：只起一个（#1077）。 */

let fixture: AgentFixture;
let node: string;
let alive: Set<string>;
let backend: "acp" | "tmux";

const manager = {
  isAlive: (sessionId: string) => alive.has(sessionId),
  session: (sessionId: string) =>
    ({ id: sessionId, backend }) as unknown as TerminalSession,
};

/** 像真的那样慢：进程起来、行落库之后才答。 */
function spawner() {
  let calls = 0;
  const spawn = async (): Promise<TerminalSession> => {
    calls += 1;
    await new Promise((done) => setTimeout(done, 20));
    const id = fixture.session(node, "codex");
    alive.add(id);
    return manager.session(id);
  };
  return { spawn, calls: () => calls };
}

beforeEach(() => {
  fixture = agentFixture();
  node = fixture.agentNode("Main", "codex");
  alive = new Set();
  backend = "acp";
});

afterEach(() => fixture.close());

describe("acpSpawnOnce", () => {
  it("同时来两次：后到的复用先起的那一行", async () => {
    const { spawn, calls } = spawner();
    const [first, second] = await Promise.all([
      acpSpawnOnce(fixture.database, manager, node, spawn),
      acpSpawnOnce(fixture.database, manager, node, spawn),
    ]);
    expect(calls()).toBe(1);
    expect(second.id).toBe(first.id);
  });

  it("先前那一行已经死了：照常起新的", async () => {
    const { spawn, calls } = spawner();
    const first = await acpSpawnOnce(fixture.database, manager, node, spawn);
    alive.delete(first.id);
    await acpSpawnOnce(fixture.database, manager, node, spawn);
    expect(calls()).toBe(2);
  });

  it("活着的是终端行：不拿它冒充 ACP 会话", async () => {
    const { spawn, calls } = spawner();
    await acpSpawnOnce(fixture.database, manager, node, spawn);
    backend = "tmux";
    await acpSpawnOnce(fixture.database, manager, node, spawn);
    expect(calls()).toBe(2);
  });
});
