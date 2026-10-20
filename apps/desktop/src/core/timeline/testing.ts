/**
 * 时间线用例的共用件（只给测试用）：内存库（全部迁移）、一段脚本化的 ACP 会话。
 */

import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AcpOpsContext } from "@armadra/shared";

import { loadMigrations } from "../db/migrations";

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "../db/migrations"),
);

/** 套满全部迁移的内存库（外键开着）。 */
export function memoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration.sql);
  return database;
}

export const msg = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
export const think = (text: string) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
export const toolCall = (
  toolCallId: string,
  extra: Record<string, unknown> = {},
) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: `Tool ${toolCallId}`,
  kind: "read",
  status: "in_progress",
  ...extra,
});
export const toolUpdate = (
  toolCallId: string,
  extra: Record<string, unknown> = {},
) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  ...extra,
});

/** 一个回合的 ACP 上下文；时间由调用方给，保证可复现。 */
export function turnCtx(
  turn: number,
  at: number,
  over: Partial<AcpOpsContext> = {},
): AcpOpsContext {
  return { turnId: `t${turn}`, turn, at, gen: 1, ...over };
}
