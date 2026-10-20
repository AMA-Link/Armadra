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

/** 手动推进的计时器：写入器与活动状态机的注入点。 */
export class FakeTimers {
  private nowMs: number;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { at: number; callback: () => void }
  >();

  constructor(start = 1_000_000) {
    this.nowMs = start;
  }

  now = (): number => this.nowMs;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.nowMs + ms, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** 往前走 `ms`，按到期顺序触发沿途的计时器。 */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.pending) {
        if (
          entry[1].at <= target &&
          (next === undefined || entry[1].at < next[1].at)
        ) {
          next = entry;
        }
      }
      if (next === undefined) break;
      this.pending.delete(next[0]);
      this.nowMs = Math.max(this.nowMs, next[1].at);
      next[1].callback();
    }
    this.nowMs = target;
  }

  get scheduled(): number {
    return this.pending.size;
  }
}

/** 在一块板上放一个终端节点并给它一行会话（路由门按会话行查画布），答会话 id。 */
export function seedSession(
  database: DatabaseSync,
  boardId: string,
  workspaceId: string,
  id: string,
  nodeId: string,
  status: "running" | "exited" = "running",
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
        "labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', 'T', '#0a84ff', 0, 0, 240, 200, '[]', '', '{}', ?, ?)",
    )
    .run(nodeId, boardId, now, now);
  database
    .prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, owner_node_id, cwd, shell, status, backend_kind, created_at) " +
        "VALUES (?, ?, ?, '/tmp', 'sh', ?, 'acp', ?)",
    )
    .run(id, workspaceId, nodeId, status, now);
}
