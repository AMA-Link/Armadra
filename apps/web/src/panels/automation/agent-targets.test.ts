import type { CanvasNode } from "@armadra/shared";
import { describe, expect, it } from "vitest";

import { agentTargets, lacksStateChannel } from "./agent-targets";

function terminal(id: string, agentId: string, ssh = false): CanvasNode {
  return {
    id,
    type: "terminal",
    title: id,
    position: { x: 0, y: 0 },
    data: {
      kind: "terminal",
      sessionId: `s-${id}`,
      cwd: "/w",
      agent: { id: agentId },
      ...(ssh ? { ssh: { hostId: "h" } } : {}),
    },
  } as unknown as CanvasNode;
}

describe("计划任务的目标", () => {
  it("没有状态通道的内置 CLI（agy）标记出来，有通道的不标（grok 自 G2 起有会话文件通道）", () => {
    expect(lacksStateChannel("agy")).toBe(true);
    for (const id of [
      "claude",
      "codex",
      "grok",
      "opencode",
      "pi",
      "omp",
      "copilot",
      "ama",
    ]) {
      expect(lacksStateChannel(id), id).toBe(false);
    }
    // 自定义条目、不认识的 id：按 core 的判断，这里不猜。
    expect(lacksStateChannel("custom:x")).toBe(false);
  });

  it("目标列表带着这个标记，远程与没有 Agent 的终端照旧不列", () => {
    const options = agentTargets([
      terminal("a", "claude"),
      terminal("b", "agy"),
      terminal("c", "agy", true),
    ]);
    expect(options.map((o) => [o.nodeId, o.noStateChannel])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
});
