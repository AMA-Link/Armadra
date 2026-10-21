/**
 * hook 事件 → 活动层（设计 §5.2 的「活动来源」列）。纯函数：给事件，答该显示什么。
 *
 *   UserPromptSubmit            → submitting
 *   PreToolUse                  → tool（标签「工具: 输入摘要」，截到 60 字）；提问类工具 → awaiting_input
 *   PostToolUse                 → thinking
 *   PermissionRequest / 通知     → awaiting_approval
 *   Stop / StopFailure / Interrupt → 回到 idle，附结局（done / failed / cancelled）
 *   SessionEnd                  → 撤销外部信号
 *
 * 只认 `state` 和 `session` 两类事件；子代理事件不进活动。
 */

import type { ActivityPhase, SessionActivity } from "@armadra/shared";

import type { AgentEvent } from "../../hook/normalize";
import type { TurnOutcome } from "../activity";

export type HookActivity =
  | {
      readonly kind: "signal";
      readonly phase: ActivityPhase;
      readonly detail?: SessionActivity["detail"];
    }
  | { readonly kind: "clear" }
  | { readonly kind: "end"; readonly outcome: TurnOutcome };

const LABEL_MAX = 60;

function label(
  name: string | undefined,
  summary: string | undefined,
): string | undefined {
  const text =
    name !== undefined && summary !== undefined
      ? `${name}: ${summary}`
      : (name ?? summary);
  if (text === undefined) return undefined;
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

export function mapHookActivity(
  event: AgentEvent,
  toolKind: (toolName: string) => string,
): HookActivity | undefined {
  if (event.kind === "session") {
    return event.sessionPhase === "end" ? { kind: "clear" } : undefined;
  }
  if (event.kind !== "state") return undefined;
  const tool = label(event.toolName, event.toolSummary);
  switch (event.hookEvent) {
    case "UserPromptSubmit":
      return { kind: "signal", phase: "submitting" };
    case "PreToolUse": {
      if (event.awaitingInput === true) {
        const asking = label(event.askKind ?? event.toolName, undefined);
        return {
          kind: "signal",
          phase: "awaiting_input",
          ...(asking !== undefined ? { detail: { label: asking } } : {}),
        };
      }
      return {
        kind: "signal",
        phase: "tool",
        detail: {
          ...(tool !== undefined ? { label: tool } : {}),
          ...(event.toolName !== undefined
            ? { toolKind: toolKind(event.toolName) }
            : {}),
        },
      };
    }
    case "PostToolUse":
      return { kind: "signal", phase: "thinking" };
    case "PermissionRequest":
      return {
        kind: "signal",
        phase: "awaiting_approval",
        ...(tool !== undefined ? { detail: { label: tool } } : {}),
      };
    case "Notification":
      if (event.state === "blocked") {
        return { kind: "signal", phase: "awaiting_approval" };
      }
      if (event.state === "waiting") {
        return { kind: "signal", phase: "awaiting_input" };
      }
      return undefined;
    case "Stop":
    case "StopFailure":
    case "Interrupt": {
      if (event.interrupted === true) {
        return { kind: "end", outcome: { kind: "cancelled" } };
      }
      if (event.errored === true) {
        return {
          kind: "end",
          outcome: {
            kind: "failed",
            ...(event.lastMessage !== undefined
              ? { error: event.lastMessage.slice(0, 4_000) }
              : {}),
          },
        };
      }
      return { kind: "end", outcome: { kind: "done" } };
    }
    default:
      return undefined;
  }
}
