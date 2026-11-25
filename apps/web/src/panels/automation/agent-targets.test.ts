import type { CanvasNode } from "@armadra/shared";
import { describe, expect, it } from "vitest";

import {
  agentTargets,
  definitionLacksChannel,
  withChannels,
  lacksStateChannel,
} from "./agent-targets";

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
  it("没有状态通道的内置 CLI标记出来，有通道的不标", () => {
    // 判据只看能力清单：用虚构条目，不依赖哪一家真实 CLI。
    expect(definitionLacksChannel({ capabilities: ["resume"] })).toBe(true);
    expect(definitionLacksChannel({ capabilities: ["hooks"] })).toBe(false);
    expect(definitionLacksChannel(undefined)).toBe(false);
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
      terminal("b", "codex"),
      terminal("c", "codex", true),
    ]);
    // 标记就是 lacksStateChannel 的答案（不押哪一家 CLI 有没有通道）。
    expect(
      options.map((o) => [
        o.nodeId,
        o.noStateChannel === lacksStateChannel(o.agentId),
      ]),
    ).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });

  it("core 按节点答 null 的置灰，答了来源名的、没答的保持原样", () => {
    const options = agentTargets([
      terminal("a", "claude"),
      terminal("b", "codex"),
      terminal("c", "claude"),
    ]);
    const merged = withChannels(options, { a: null, b: "hook" });
    expect(merged.map((o) => [o.nodeId, o.noStateChannel])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    // 还没答（undefined）：原样。
    expect(withChannels(options, undefined)).toEqual(options);
  });
});
