import type {
  TimelineAssistantItem,
  TimelineNoticeItem,
  TimelineThoughtItem,
  TimelineToolItem,
  TimelineUserItem,
} from "../src/index.js";

/** 可复现的伪随机数（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const common = { source: "acp", gen: 0 } as const;

export function user(
  id: string,
  turn: number,
  ord: number,
  text = "hi",
): TimelineUserItem {
  return {
    ...common,
    id,
    kind: "user",
    turn,
    ord,
    rev: 0,
    at: 1000 + ord,
    text,
  };
}

export function assistant(
  id: string,
  turn: number,
  ord: number,
  text: string,
  streaming = true,
): TimelineAssistantItem {
  return {
    ...common,
    id,
    kind: "assistant",
    turn,
    ord,
    rev: 0,
    at: 1000 + ord,
    parts: [{ type: "text", text }],
    streaming,
  };
}

export function thought(
  id: string,
  turn: number,
  ord: number,
  text: string,
  streaming = true,
): TimelineThoughtItem {
  return {
    ...common,
    id,
    kind: "thought",
    turn,
    ord,
    rev: 0,
    at: 1000 + ord,
    text,
    streaming,
  };
}

export function tool(
  toolCallId: string,
  turn: number,
  ord: number,
  patch: Partial<TimelineToolItem> = {},
): TimelineToolItem {
  return {
    ...common,
    id: `tool:${toolCallId}`,
    kind: "tool",
    turn,
    ord,
    rev: 0,
    at: 1000 + ord,
    toolCallId,
    toolKind: "read",
    title: toolCallId,
    status: "pending",
    locations: [],
    content: [],
    startedAt: 1000 + ord,
    ...patch,
  };
}

export function notice(
  id: string,
  turn: number,
  ord: number,
): TimelineNoticeItem {
  return {
    ...common,
    id,
    kind: "notice",
    turn,
    ord,
    rev: 0,
    at: 1000 + ord,
    code: "mode_changed",
    params: { name: "x" },
  };
}
