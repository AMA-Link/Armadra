import { ARMADRA_MCP_SERVER, ARMADRA_MCP_TOOLS } from "@armadra/shared";
import { describe, expect, it } from "vitest";

import { VERB_TOOLS } from "../../hook-client/verbs";
import { CANVAS_MCP_NAME } from "./mcp";
import { OwnToolCalls, allowOnceOption, isOwnTool } from "./own-tools";
import type { AcpPermissionOption, AcpToolCallUpdate } from "./types";

/** Codex 适配器的四个选项（两种 `allow_always`）。 */
const CODEX_OPTIONS: AcpPermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  {
    optionId: "allow_session",
    name: "Allow for this session",
    kind: "allow_always",
  },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "cancel", name: "Cancel", kind: "reject_once" },
];

const codexToolCall = (id: string, server: string, tool: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: `mcp.${server}.${tool}`,
  kind: "execute",
  status: "in_progress",
  rawInput: { server, tool, arguments: {} },
  _meta: { is_mcp_tool_call: true },
});

/** Codex 的审批请求只带 `toolCallId`。 */
const bare = (id: string): AcpToolCallUpdate =>
  ({ toolCallId: id, kind: "execute", status: "pending" }) as AcpToolCallUpdate;

describe("the shared tool list", () => {
  it("is VERB_TOOLS, same names in the same order", () => {
    expect([...ARMADRA_MCP_TOOLS]).toEqual(VERB_TOOLS.map((tool) => tool.name));
    expect(ARMADRA_MCP_SERVER).toBe(CANVAS_MCP_NAME);
  });
});

describe("isOwnTool", () => {
  it("is our server and a VERB_TOOLS name, nothing else", () => {
    expect(isOwnTool({ server: "armadra", tool: "canvas_wait" })).toBe(true);
    expect(isOwnTool({ server: "armadra", tool: "browser_click" })).toBe(true);
    expect(isOwnTool({ server: "armadra", tool: "shell" })).toBe(false);
    expect(isOwnTool({ server: "notes", tool: "canvas_wait" })).toBe(false);
    expect(isOwnTool(undefined)).toBe(false);
  });
});

describe("OwnToolCalls.decide", () => {
  it("answers our tool with allow_once, never an always option", () => {
    const calls = new OwnToolCalls();
    calls.record(codexToolCall("c1", "armadra", "canvas_wait"));
    expect(calls.decide(bare("c1"), CODEX_OPTIONS)).toBe("allow_once");
  });

  it("leaves a foreign MCP tool to a person", () => {
    const calls = new OwnToolCalls();
    calls.record(codexToolCall("c2", "notes", "search_notes"));
    expect(calls.decide(bare("c2"), CODEX_OPTIONS)).toBeUndefined();
  });

  it("leaves an unknown verb on our server to a person", () => {
    const calls = new OwnToolCalls();
    calls.record(codexToolCall("c3", "armadra", "delete_everything"));
    expect(calls.decide(bare("c3"), CODEX_OPTIONS)).toBeUndefined();
  });

  it("never trusts the title", () => {
    const calls = new OwnToolCalls();
    calls.record({
      sessionUpdate: "tool_call",
      toolCallId: "c4",
      title: "mcp.armadra.canvas_wait",
      kind: "execute",
      rawInput: { server: "armadra", tool: "canvas_wait" },
    });
    expect(calls.decide(bare("c4"), CODEX_OPTIONS)).toBeUndefined();
    expect(
      calls.decide(
        {
          toolCallId: "c5",
          title: "mcp.armadra.canvas_wait",
        } as AcpToolCallUpdate,
        CODEX_OPTIONS,
      ),
    ).toBeUndefined();
  });

  it("only borrows the recorded provenance when the request carries none", () => {
    const calls = new OwnToolCalls();
    calls.record(codexToolCall("c6", "armadra", "canvas_post"));
    // 同一个 id 的请求却自称是 Bash：只认请求自己的身份。
    expect(
      calls.decide(
        {
          toolCallId: "c6",
          title: "rm -rf build",
          kind: "execute",
          _meta: { claudeCode: { toolName: "Bash" } },
        } as AcpToolCallUpdate,
        CODEX_OPTIONS,
      ),
    ).toBeUndefined();
  });

  it("reads Claude's own provenance on the request", () => {
    const calls = new OwnToolCalls();
    const options: AcpPermissionOption[] = [
      { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ];
    const call = {
      toolCallId: "toolu_1",
      title: "armadra - canvas_post (MCP)",
      rawInput: { to: "reviewer", text: "done" },
      _meta: {
        claudeCode: {
          toolName: "mcp__armadra__canvas_post",
          mcpServer: { name: "armadra", source: "dynamic" },
        },
      },
    } as unknown as AcpToolCallUpdate;
    expect(calls.decide(call, options)).toBe("allow");
    const foreign = {
      ...call,
      _meta: { claudeCode: { toolName: "mcp__notes__canvas_post" } },
    } as unknown as AcpToolCallUpdate;
    expect(calls.decide(foreign, options)).toBeUndefined();
  });

  it("falls back to a person when there is no allow_once", () => {
    const calls = new OwnToolCalls();
    calls.record(codexToolCall("c7", "armadra", "canvas_wait"));
    expect(
      calls.decide(
        bare("c7"),
        CODEX_OPTIONS.filter((option) => option.kind !== "allow_once"),
      ),
    ).toBeUndefined();
    expect(allowOnceOption([])).toBeUndefined();
  });

  it("forgets the oldest calls past the cap and counts per turn", () => {
    const calls = new OwnToolCalls();
    calls.record(codexToolCall("old", "armadra", "canvas_wait"));
    for (let i = 0; i < 300; i += 1)
      calls.record(codexToolCall(`n${i}`, "armadra", "canvas_list"));
    expect(calls.decide(bare("old"), CODEX_OPTIONS)).toBeUndefined();
    expect(calls.decide(bare("n299"), CODEX_OPTIONS)).toBe("allow_once");
    calls.noteApproved();
    calls.noteApproved();
    expect(calls.takeTurnCounts()).toEqual({ turn: 2, total: 2 });
    calls.noteApproved();
    expect(calls.takeTurnCounts()).toEqual({ turn: 1, total: 3 });
  });
});
