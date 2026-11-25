import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  agentDefinition,
  conversationsResponseSchema,
  suggestTitleResponseSchema,
  type AgentInfo,
  type Conversation,
} from "@armadra/shared";

import { buildResumeLaunch } from "../agent/launch";
import { runtimeApi } from "../api/client";
import { currentSource } from "../api/source";

/**
 * 历史对话索引（计划书 §17「对话索引与 resume」）。
 *
 * Runtime 扫各 provider 的转录目录建表，`GET /api/conversations?q=&limit=`
 * 返回标题 + 目录 + 时间；命令面板选中一条就以 `--resume <id>` 起一个新的
 * 终端节点。
 *
 * 这里对 Runtime 侧的接口做**软引用**：`api/client.ts` 的 `conversations` /
 * `suggestTitle` 由 runtime-index 那位 agent 补，补上之前退回裸 fetch，
 * 补上之后自动走带鉴权头与错误映射的正规路径。
 */

export type { Conversation };

interface OptionalRuntimeApi {
  conversations?: (query: string, limit: number) => Promise<unknown>;
  suggestTitle?: (nodeId: string) => Promise<unknown>;
}

function unwrap(payload: unknown): Conversation[] {
  const parsed = conversationsResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data : [];
}

export async function fetchConversations(
  query: string,
  limit = 20,
): Promise<Conversation[]> {
  const optional = runtimeApi as unknown as OptionalRuntimeApi;
  if (typeof optional.conversations === "function") {
    return unwrap(await optional.conversations(query, limit));
  }
  if (typeof fetch !== "function") return [];
  const source = currentSource();
  const url = `${source.httpBase}/api/conversations?q=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await source.fetch(url);
  if (!response.ok) return [];
  return unwrap(await response.json());
}

/** `POST /api/agent-status/{nodeId}/suggest-title` → 新标题。 */
export async function suggestTitle(nodeId: string): Promise<string> {
  const optional = runtimeApi as unknown as OptionalRuntimeApi;
  if (typeof optional.suggestTitle === "function") {
    return suggestTitleResponseSchema.parse(await optional.suggestTitle(nodeId))
      .title;
  }
  const source = currentSource();
  const response = await source.fetch(
    `${source.httpBase}/api/agent-status/${encodeURIComponent(nodeId)}/suggest-title`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(String(response.status));
  return suggestTitleResponseSchema.parse(await response.json()).title;
}

/* ------------------------------ resume 启动行 ----------------------------- */

/**
 * 恢复某条历史对话的启动行（§17）。
 *
 * 拼行经 `agent/launch.ts` 的 `buildResumeLaunch`（claude 是 `--resume` flag，
 * codex 是 `resume` 子命令，opencode 没有这个能力位），与新开的节点同一个出口
 * ——画布注入的 argv 照带。这里只负责在 provider 不认识或不支持恢复时返回
 * `null`，让调用方把那一行禁掉。
 */
export function resumeLaunchCommand(
  provider: string,
  sessionId: string,
): string | null {
  if (!agentDefinition(provider)?.resume) return null;
  try {
    return buildResumeLaunch(provider, sessionId).command;
  } catch {
    return null;
  }
}

/**
 * 一条历史对话怎么接回：终端的 `--resume` 行，或者经 ACP 的 `session/load`。
 * 没有终端 `resume` 能力位、但 ACP 入口装了且能接回的 CLI（Antigravity：终端里
 * 没有会话 id 可接，而 ACP 的 `sessionId` 就是它的会话 id）走后者；都不行是 `null`。
 */
export type ResumeTarget =
  | { readonly kind: "terminal"; readonly command: string }
  | { readonly kind: "acp" };

export function resumeTarget(
  conversation: Pick<Conversation, "provider" | "sessionId">,
  agents: readonly Pick<AgentInfo, "id" | "acp">[],
): ResumeTarget | null {
  const command = resumeLaunchCommand(
    conversation.provider,
    conversation.sessionId,
  );
  if (command) return { kind: "terminal", command };
  const acp = agents.find((agent) => agent.id === conversation.provider)?.acp;
  if (acp?.installed === true && acp.resume !== "none") return { kind: "acp" };
  return null;
}

/** 接回的新终端节点的标题与数据；命令面板与侧栏搜索共用。 */
export function resumeNodeInput(
  conversation: Conversation,
  target: ResumeTarget,
): { title: string; data: Record<string, unknown> } {
  const base = { kind: "terminal", cwd: conversation.cwd };
  if (target.kind === "acp") {
    return {
      title: conversation.title,
      data: {
        ...base,
        agent: {
          id: conversation.provider,
          // 与「接管会话」同一条路：节点记着 CLI 的会话 id，起会话时走接回。
          driver: "acp",
          sessionId: conversation.sessionId,
        },
      },
    };
  }
  return {
    title: conversation.title,
    data: {
      ...base,
      agent: {
        id: conversation.provider,
        initialCommand: target.command,
        // 启动行在这里就定了，交给 `pending-launch`（无依赖 = 提示符一安静就敲）。
        pendingLaunch: { command: target.command, after: [] },
      },
    },
  };
}

/* ---------------------------------- hooks --------------------------------- */

/** 输入去抖：命令面板每敲一个字都查一次索引没有意义。 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export const CONVERSATION_DEBOUNCE_MS = 150;
/** 空查询时只列最近这么多条，免得面板被历史淹掉（§17）。 */
export const CONVERSATION_IDLE_LIMIT = 8;
export const CONVERSATION_LIMIT = 20;

export function useConversations(query: string, enabled: boolean) {
  const debounced = useDebounced(query.trim(), CONVERSATION_DEBOUNCE_MS);
  const limit = debounced ? CONVERSATION_LIMIT : CONVERSATION_IDLE_LIMIT;
  return useQuery({
    queryKey: ["conversations", debounced, limit],
    queryFn: () => fetchConversations(debounced, limit),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
