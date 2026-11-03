import { describe, expect, it } from "vitest";
import {
  ARMADRA_MCP_SERVER,
  ARMADRA_MCP_TOOLS,
  type TimelineToolItem,
  acpMcpArguments,
  acpMcpToolOf,
  emptyTimelineState,
  isArmadraMcpTool,
  reduceAcpUpdate,
} from "../src/index.js";

const codexCall = (server: string, tool: string, extra = {}) => ({
  toolCallId: "c1",
  title: `mcp.${server}.${tool}`,
  kind: "execute",
  rawInput: { server, tool, arguments: { node: "builder", n: 40 } },
  _meta: { is_mcp_tool_call: true },
  ...extra,
});

const claudeCall = (toolName: string, mcpServer?: { name: string }) => ({
  toolCallId: "c2",
  title: toolName,
  rawInput: { node: "builder" },
  _meta: {
    claudeCode: { toolName, ...(mcpServer ? { mcpServer } : {}) },
  },
});

describe("acpMcpToolOf：只认结构化来源", () => {
  it("Codex：_meta.is_mcp_tool_call + rawInput.{server,tool}", () => {
    expect(acpMcpToolOf(codexCall("armadra", "canvas_wait"))).toEqual({
      server: "armadra",
      tool: "canvas_wait",
    });
  });

  it("Claude：mcp__<server>__<tool>，带 mcpServer 时必须一致", () => {
    expect(acpMcpToolOf(claudeCall("mcp__armadra__canvas_post"))).toEqual({
      server: "armadra",
      tool: "canvas_post",
    });
    expect(
      acpMcpToolOf(
        claudeCall("mcp__armadra__canvas_post", { name: "armadra" }),
      ),
    ).toEqual({ server: "armadra", tool: "canvas_post" });
    expect(
      acpMcpToolOf(claudeCall("mcp__armadra__canvas_post", { name: "other" })),
    ).toBeUndefined();
    expect(acpMcpToolOf(claudeCall("Bash"))).toBeUndefined();
    expect(acpMcpToolOf(claudeCall("mcp__armadra"))).toBeUndefined();
  });

  it("标题写成 mcp.armadra.* 不算来源", () => {
    expect(
      acpMcpToolOf({
        toolCallId: "x",
        title: "mcp.armadra.canvas_wait",
        kind: "execute",
        rawInput: { server: "armadra", tool: "canvas_wait" },
      }),
    ).toBeUndefined();
    expect(
      acpMcpToolOf({ title: "mcp__armadra__canvas_wait", _meta: {} }),
    ).toBeUndefined();
  });

  it("形状不对的一律不认", () => {
    expect(acpMcpToolOf(null)).toBeUndefined();
    expect(acpMcpToolOf("x")).toBeUndefined();
    expect(
      acpMcpToolOf({ _meta: { is_mcp_tool_call: true }, rawInput: "x" }),
    ).toBeUndefined();
    expect(
      acpMcpToolOf({
        _meta: { is_mcp_tool_call: true },
        rawInput: { server: "armadra", tool: 3 },
      }),
    ).toBeUndefined();
    expect(
      acpMcpToolOf({
        _meta: { is_mcp_tool_call: true },
        rawInput: { server: "a".repeat(201), tool: "t" },
      }),
    ).toBeUndefined();
  });
});

describe("isArmadraMcpTool", () => {
  it("只认自家服务器上清单里的工具", () => {
    expect(isArmadraMcpTool({ server: "armadra", tool: "canvas_wait" })).toBe(
      true,
    );
    expect(isArmadraMcpTool({ server: "armadra", tool: "rm_rf" })).toBe(false);
    expect(isArmadraMcpTool({ server: "notes", tool: "canvas_wait" })).toBe(
      false,
    );
    expect(isArmadraMcpTool(undefined)).toBe(false);
  });

  it("清单不重复、都是 [A-Za-z0-9_]", () => {
    expect(new Set(ARMADRA_MCP_TOOLS).size).toBe(ARMADRA_MCP_TOOLS.length);
    for (const name of ARMADRA_MCP_TOOLS) expect(name).toMatch(/^\w+$/);
    expect(ARMADRA_MCP_SERVER).toBe("armadra");
  });
});

describe("acpMcpArguments", () => {
  it("Codex 的包装取 arguments；其余原样", () => {
    expect(acpMcpArguments(codexCall("armadra", "context_terminal"))).toEqual({
      node: "builder",
      n: 40,
    });
    expect(acpMcpArguments(claudeCall("mcp__armadra__canvas_post"))).toEqual({
      node: "builder",
    });
  });

  it("后续帧没有 _meta 时按已认定的来源拆包装", () => {
    const later = {
      toolCallId: "c1",
      rawInput: { server: "armadra", tool: "canvas_wait", arguments: { a: 1 } },
    };
    expect(
      acpMcpArguments(later, { server: "armadra", tool: "canvas_wait" }),
    ).toEqual({ a: 1 });
    expect(acpMcpArguments(later)).toEqual(later.rawInput);
  });
});

describe("时间线：工具条目的 mcp 字段", () => {
  const at = { turnId: "t1", turn: 1, at: 1_000, gen: 0 };
  it("记来源、入参读 arguments，完成帧不抹掉来源", () => {
    let state = emptyTimelineState();
    state = reduceAcpUpdate(
      state,
      {
        sessionUpdate: "tool_call",
        status: "in_progress",
        ...codexCall("armadra", "context_terminal"),
      },
      at,
    ).state;
    state = reduceAcpUpdate(
      state,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        rawInput: {
          server: "armadra",
          tool: "context_terminal",
          arguments: { node: "builder", n: 40 },
        },
      },
      { ...at, at: 1_004 },
    ).state;
    const item = state.items["tool:c1"] as TimelineToolItem;
    expect(item.mcp).toEqual({ server: "armadra", tool: "context_terminal" });
    expect(item.status).toBe("completed");
    expect(item.input).toEqual({
      fields: [
        { key: "node", value: "builder" },
        { key: "n", value: "40" },
      ],
    });
  });

  it("普通工具没有 mcp 字段", () => {
    const state = reduceAcpUpdate(
      emptyTimelineState(),
      {
        sessionUpdate: "tool_call",
        toolCallId: "r1",
        title: "mcp.armadra.canvas_wait",
        kind: "execute",
        rawInput: { server: "armadra", tool: "canvas_wait" },
      },
      at,
    ).state;
    const item = state.items["tool:r1"] as TimelineToolItem;
    expect(item.mcp).toBeUndefined();
  });
});
