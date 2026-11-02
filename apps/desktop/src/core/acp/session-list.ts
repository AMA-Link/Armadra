/**
 * 列出 Agent 自己历史里的会话（`session/list`，P2-7）：新建 Agent 时的「接管已有
 * 会话」用。
 *
 * 只在 Agent 声明了 `sessionCapabilities.list` 时才发。按页取（`listSessions(cwd,
 * cursor, signal)`；0.11 的客户端不带 `signal`）：自己翻页，收满
 * {@link MAX_LISTED_SESSIONS} 条就停并把下一页的游标交回去，不再整段收完再截断。
 * 给了 `root` 时，不管 Agent 有没有按 `cwd` 过滤，只留在根目录之下的会话。
 */

import { isAbsolute, relative, resolve } from "node:path";

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

/**
 * 一次大约答这么多条：Agent 的历史可能很长，页面只是个选择器。收满就停并给游标，
 * 其余的由翻页取（按整页收，所以可能略多）。
 */
export const MAX_LISTED_SESSIONS = 200;

/** 单页最多收这么多条，防对端一页塞下整个历史。 */
export const MAX_PAGE_SESSIONS = 1000;

/** 一次最多翻这么多页（过滤掉大半时也不会无限翻）。 */
const MAX_LIST_PAGES = 50;

/** `candidate` 就是 `root`，或在它之下（按路径段比较，`/w-x` 不在 `/w` 里）。 */
export function withinRoot(root: string, candidate: string): boolean {
  if (candidate === "") return false;
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

interface ListCapableClient {
  supportsList?(): boolean;
  listSessions?(
    cwd?: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<AcpListSessionsResult>;
}

function clip(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value !== ""
    ? value.slice(0, limit)
    : undefined;
}

/** Agent 答的会话列表收成线上形状：丢掉没有 id 的，字段截断，条数封顶。 */
export function listedSessions(
  raw: unknown,
  limit: number = MAX_LISTED_SESSIONS,
): ListedSession[] {
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
    if (out.length >= limit) break;
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
    /** 工作空间根：只答在它之下的会话，不管 Agent 报了什么（空 = 不限，仅内部用）。 */
    readonly root?: string | undefined;
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
    const { root } = params;
    const collected: ListedSession[] = [];
    let cursor = params.cursor;
    let next: string | undefined;
    for (let pages = 0; pages < MAX_LIST_PAGES; pages++) {
      const page = await client.listSessions(params.cwd, cursor, params.signal);
      const entries = listedSessions(page?.sessions, MAX_PAGE_SESSIONS);
      for (const entry of entries) {
        if (root === undefined || withinRoot(root, entry.cwd)) {
          collected.push(entry);
        }
      }
      next = clip(page?.nextCursor, 1024);
      // 对端把游标原样回来会翻不完：当作到头。
      if (next === cursor) next = undefined;
      if (next === undefined) break;
      // 按整页收：收满就停，游标留给下一次，一条也不丢。
      if (collected.length >= MAX_LISTED_SESSIONS) break;
      cursor = next;
    }
    return {
      sessions: collected,
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
