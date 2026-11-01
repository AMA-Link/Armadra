/**
 * 列出 Agent 自己历史里的会话（`session/list`，P2-7）：新建 Agent 时的「接管已有
 * 会话」用。
 *
 * 只在 Agent 声明了 `sessionCapabilities.list` 时才发。新版客户端有
 * `listAllSessions(cwd, signal)`（把分页收完）和带 `signal` 的
 * `listSessions(cwd, cursor, signal)`；0.11 只有不带 `signal` 的
 * `listSessions(cwd, cursor)`。有哪个用哪个：不给游标时优先 `listAllSessions`，
 * 否则按页取。
 */

import { AcpError } from "./client";
import type { AdapterProcessContext } from "./host";
import type { AcpListSessionsResult } from "./types";

/** 一条 Agent 自己的会话（线上形状）。 */
export interface ListedSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

export interface SessionListing {
  readonly sessions: readonly ListedSession[];
  readonly nextCursor?: string;
}

/** 一次最多答这么多条：Agent 的历史可能很长，页面只是个选择器。 */
export const MAX_LISTED_SESSIONS = 200;

interface ListCapableClient {
  supportsList?(): boolean;
  listSessions?(
    cwd?: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<AcpListSessionsResult>;
  listAllSessions?(
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<AcpListSessionsResult | AcpListSessionsResult["sessions"]>;
}

function clip(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value !== ""
    ? value.slice(0, limit)
    : undefined;
}

/** Agent 答的会话列表收成线上形状：丢掉没有 id 的，字段截断，条数封顶。 */
export function listedSessions(raw: unknown): ListedSession[] {
  if (!Array.isArray(raw)) return [];
  const out: ListedSession[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const sessionId = clip(entry.sessionId, 512);
    if (sessionId === undefined) continue;
    const title = clip(entry.title, 200);
    const updatedAt = clip(entry.updatedAt, 64);
    out.push({
      sessionId,
      cwd: clip(entry.cwd, 4096) ?? "",
      ...(title === undefined ? {} : { title }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
    if (out.length >= MAX_LISTED_SESSIONS) break;
  }
  return out;
}

/** 在一个已经协商好的适配器上列会话。Agent 或客户端没有这个能力答 `acp_list_unsupported`。 */
export async function listSessionsOn(
  context: Pick<AdapterProcessContext, "capabilities"> & {
    readonly process: { readonly client: unknown };
  },
  params: {
    readonly cwd?: string | undefined;
    readonly cursor?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<SessionListing> {
  const client = context.process.client as ListCapableClient;
  const declared =
    typeof client.supportsList === "function"
      ? client.supportsList()
      : context.capabilities.list;
  if (!declared || typeof client.listSessions !== "function") {
    throw new AcpError(
      "acp_list_unsupported",
      "the agent cannot list its sessions",
    );
  }
  try {
    if (
      params.cursor === undefined &&
      typeof client.listAllSessions === "function"
    ) {
      const all = await client.listAllSessions(params.cwd, params.signal);
      const list = Array.isArray(all) ? all : all.sessions;
      return { sessions: listedSessions(list) };
    }
    const page = await client.listSessions(
      params.cwd,
      params.cursor,
      params.signal,
    );
    const next = clip(page?.nextCursor, 1024);
    return {
      sessions: listedSessions(page?.sessions),
      ...(next === undefined ? {} : { nextCursor: next }),
    };
  } catch (error) {
    if (error instanceof AcpError) throw error;
    throw new AcpError(
      "acp_session_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
