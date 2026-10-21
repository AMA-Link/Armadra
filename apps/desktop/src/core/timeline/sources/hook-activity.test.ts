import { describe, expect, it } from "vitest";

import { normalizeAs } from "../../hook/normalize";
import { mapHookActivity } from "./hook-activity";

const claude = (payload: Record<string, unknown>) => {
  const event = normalizeAs("claude", "claude", "node-1", payload);
  if (event === undefined) throw new Error("not understood");
  return mapHookActivity(event, (name) =>
    name === "Bash" ? "execute" : "other",
  );
};

describe("hook → activity", () => {
  it("maps a prompt, a tool, its end and a permission ask", () => {
    expect(
      claude({ hook_event_name: "UserPromptSubmit", prompt: "go" }),
    ).toEqual({
      kind: "signal",
      phase: "submitting",
    });
    expect(
      claude({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      }),
    ).toEqual({
      kind: "signal",
      phase: "tool",
      detail: { label: "Bash: pnpm test", toolKind: "execute" },
    });
    expect(
      claude({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    ).toEqual({ kind: "signal", phase: "thinking" });
    expect(
      claude({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf x" },
      }),
    ).toEqual({
      kind: "signal",
      phase: "awaiting_approval",
      detail: { label: "Bash: rm -rf x" },
    });
  });

  it("maps a question tool to awaiting_input", () => {
    expect(
      claude({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    ).toMatchObject({ kind: "signal", phase: "awaiting_input" });
  });

  it("maps Stop to an outcome and truncates long labels to 60", () => {
    expect(claude({ hook_event_name: "Stop" })).toEqual({
      kind: "end",
      outcome: { kind: "done" },
    });
    expect(claude({ hook_event_name: "StopFailure" })).toMatchObject({
      kind: "end",
      outcome: { kind: "failed" },
    });
    expect(claude({ hook_event_name: "Stop", interrupted: true })).toEqual({
      kind: "end",
      outcome: { kind: "cancelled" },
    });
    const long = claude({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "x".repeat(300) },
    });
    expect(long?.kind === "signal" && long.detail?.label?.length).toBe(60);
  });

  it("clears on session end and ignores what it does not know", () => {
    expect(claude({ hook_event_name: "SessionEnd" })).toEqual({
      kind: "clear",
    });
    expect(claude({ hook_event_name: "SessionStart" })).toBeUndefined();
    expect(
      claude({ hook_event_name: "SubagentStart", subagent_type: "x" }),
    ).toBeUndefined();
  });
});
