import { z } from "zod";

export const NODE_TYPES = [
  "terminal",
  "sticky",
  "group",
  "editor",
  "diff",
  "files",
  "browser",
  "automation",
  "agentActivity",
  "git",
  "forge",
  "forgeItem",
] as const;

/** Only one edge kind is persisted; rope/subagent edges are derived per frame. */
export const EDGE_KINDS = ["link"] as const;

/**
 * 一条连线上两端的关系（`docs/design/agent-delivery.md` §10 的续作）。
 *
 * `peer` 是对等：两边互相能读、互相能投，画布上就是一条线。
 * `supervises` 是主从，**有方向**：`source` 是主，`target` 是从。方向不是装饰
 * ——「谁在盯着谁」要能一眼看出来，而一条无向的线回答不了这个问题。
 *
 * 缺省视为 `peer`：这条字段是后加的，一块在它之前存下来的画布上每条线都是
 * 对等线，把缺省读成主从会凭空给所有人安排一个上级。
 */
export const EDGE_ROLES = ["peer", "supervises"] as const;

/** Node colour palette — plan §3.4. */
export const NODE_COLORS = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
] as const;

export const DEFAULT_NODE_COLOR = NODE_COLORS[0];

export const AGENT_STATES = ["working", "waiting", "blocked", "done"] as const;

/**
 * Which channel a node's state was learned through — docs/design/agent-collaboration-channels.md §3.2.
 *
 * The distinction is not decoration. `hook` and `extension` are the same three
 * layers of authentication over two transports (a forked `armadra-hook`, or an
 * in-process extension on the same socket), and either one is evidence a turn
 * really ended. `observed` is the PTY-side guess of §3.4: it may drive a header
 * hint and auto-naming, and it must never satisfy the idle gate that lets a
 * prompt be written into somebody's terminal. An absent source means nothing
 * has reported at all, which is a grey badge, not an idle one. `acp` is a
 * session the core drives over the Agent Client Protocol
 * (docs/design/acp-session-view.md §4.1): the protocol itself reports turns,
 * so it is as much a report as `hook`.
 */
export const AGENT_STATE_SOURCES = [
  "hook",
  "extension",
  "observed",
  "acp",
  // core 自己读 CLI 写下的会话记录得出的状态（契约 §123，协议 minor 53）：grok 的
  // `events.jsonl`，按节点 PTY 进程在它的 `active_sessions.json` 里的行绑定。
  "transcript",
] as const;

/**
 * 「是否上报」的判定与词汇表的唯一出处。
 *
 * 判一条状态来源算不算「CLI 自己报的」，全仓库只问这里，不再各处手写
 * `=== "hook" || …`：新增来源时只改这一处，`apps/desktop/src/core/agent/state-source.test.ts`
 * 守着没有人绕开它。三档：
 *   * {@link stateSourceIsReported}：上报级——`hook`、`extension`、`acp`。能满足
 *     空闲门、能当休眠与投递的依据；
 *   * {@link stateSourceIsRunReport}：能进运行关联报告的上报——只有带终端绑定、
 *     验过节点令牌的 `hook` 与 `extension`（`acp` 不经这条路）；
 *   * {@link stateSourceIsObserved}：观察级——`observed`，只是猜测，仅用于显示。
 */
export const REPORTED_STATE_SOURCES = [
  "hook",
  "extension",
  "acp",
  "transcript",
] as const;
export const RUN_REPORT_STATE_SOURCES = ["hook", "extension"] as const;

export function stateSourceIsReported(
  source: string | null | undefined,
): boolean {
  return (REPORTED_STATE_SOURCES as readonly string[]).includes(source ?? "");
}

export function stateSourceIsRunReport(
  source: string | null | undefined,
): boolean {
  return (RUN_REPORT_STATE_SOURCES as readonly string[]).includes(source ?? "");
}

export function stateSourceIsObserved(
  source: string | null | undefined,
): boolean {
  return source === "observed";
}

export const PERMISSION_MODES = [
  "default",
  "auto-edit",
  "full-auto",
  "plan",
] as const;

export const nodeTypeSchema = z.enum(NODE_TYPES);
export const edgeKindSchema = z.enum(EDGE_KINDS);
export const edgeRoleSchema = z.enum(EDGE_ROLES);
export const nodeColorSchema = z.enum(NODE_COLORS);
export const agentStateSchema = z.enum(AGENT_STATES);
export const agentStateSourceSchema = z.enum(AGENT_STATE_SOURCES);
export const permissionModeSchema = z.enum(PERMISSION_MODES);

export type CanvasNodeType = (typeof NODE_TYPES)[number];
export type CanvasEdgeKind = (typeof EDGE_KINDS)[number];
export type CanvasEdgeRole = (typeof EDGE_ROLES)[number];
export type NodeColor = (typeof NODE_COLORS)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type AgentStateSource = (typeof AGENT_STATE_SOURCES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
