/**
 * 会话读模型（§3.5 / §13.4）。
 *
 * `GET /api/workspaces/{id}/sessions` 给出「有哪些会话」，
 * `agent.status` 事件给出「它们现在怎么样」，两者在这里合流成 `SessionRow`。
 * 分桶与排序都是纯函数，侧栏只负责渲染。
 */
import { activeSourceId, scoped, srcKey } from "../sources/scope";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  compareActivityRev,
  type AgentState,
  type AgentStatus,
  type ProgramStatus,
  type SessionActivity,
  type SessionSummary,
} from "@armadra/shared";

import { sourceById } from "../api/source";
import { sourceApi } from "../sources/source-api";
import { displayOfRow } from "./display";
import { useProgramStatusStore } from "./program-status-store";
import {
  isAttention,
  useAgentStatusStore,
  type MirroredStatus,
} from "./status-store";

export interface SessionRow {
  nodeId: string;
  boardId: string;
  sessionId: string;
  title: string;
  cwd: string;
  agentId?: string;
  state?: AgentState;
  stateSource?: AgentStatus["stateSource"];
  unread: boolean;
  pendingId?: string;
  /** 最近一个回合出错结束（与 `unread` 一起决定「出错」是否还要人处理）。 */
  errored?: boolean;
  /** 最近一个回合被人打断；与 `errored` 一起决定状态点的色调（S1）。 */
  interrupted?: boolean;
  /** 重启后从库里读回来的旧行：判决成立，但不冒充「刚跑完」。 */
  restored?: boolean;
  /** core 算的细粒度活动（启动、恢复、思考、调用工具……）；没有时间线的会话没有。 */
  activity?: SessionActivity;
  /** 程序自报的状态（OSC），在 `sessionDisplay()` 里与上报合并（S5）。 */
  program?: ProgramStatus;
  /**
   * 最近一条 hook 事件所属 Agent 会话的阶段。hook 归约在 `SessionStart` 与
   * `SessionEnd` 时都清掉 `state`，只有它能分开「刚启动、空闲」和「已退出」。
   */
  sessionPhase?: AgentStatus["sessionPhase"];
  updatedAt: string;
  /** 该 Runtime 实例里进程还活着。 */
  alive: boolean;
  /** 会话的驱动方式；`acp` 的行带一个徽标（ACP 设计 §4.4）。 */
  backend?: SessionSummary["backend"];
  /** 停留在当前状态多久（毫秒）。 */
  sinceMs: number;
}

export const SESSION_BUCKETS = [
  "attention",
  "unread",
  "working",
  "idle",
  "unknown",
] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];

export interface SessionSection {
  bucket: SessionBucket;
  rows: SessionRow[];
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * 状态模式的分区归属，顺序即优先级（§3.5）。归属从 `sessionDisplay()` 来：
 * 要你处理的（审批 / 回答）> 在跑的 > 结束了没看的（含出错）> 空闲 > 未知。
 */
export function sessionBucket(row: SessionRow): SessionBucket {
  const display = displayOfRow(row);
  if (display.tone === "attention") return "attention";
  // 正在运行的节点按当前状态归类（与 MiniMap 一致）；未读只在行内显示标记。
  if (display.busy || display.tone === "queued") return "working";
  // 进程退出后没看过的结果（含出错）照样要看，所以不看 `alive`。
  if (row.unread) return "unread";
  if (display.phase !== "unknown") return "idle";
  if (row.state) return "idle";
  // 新开的 CLI 是空闲的，不是未知：hook 归约规则 4 只是把上一轮的状态清掉了。
  if (row.sessionPhase === "start") return "idle";
  return "unknown";
}

/**
 * 终端里的 Agent 已经退出：`SessionEnd` 之后进程还在（退回了 shell），但那
 * 已经不是一个 Agent 了。正在跑或在等人的状态比阶段新，按它算。
 */
export function agentExited(row: SessionRow): boolean {
  return (
    row.sessionPhase === "end" && !displayOfRow(row).busy && !isAttention(row)
  );
}

function optionalErrored(errored: boolean | undefined): {
  errored?: boolean;
} {
  return errored === undefined ? {} : { errored };
}

/** 两份活动里新的那份；`bootId` 不同（core 重启过）取镜像里后到的。 */
function newerActivity(
  summary: SessionActivity | undefined,
  mirrored: SessionActivity | undefined,
): SessionActivity | undefined {
  if (summary === undefined) return mirrored;
  if (mirrored === undefined) return summary;
  const order = compareActivityRev(summary.rev, mirrored.rev);
  return order !== null && order > 0 ? summary : mirrored;
}

/**
 * 会话摘要 + 状态镜像（+ 程序自报）→ 列表行。状态镜像更新时它比摘要新，
 * 因此优先；程序自报以页面里的活数据为准，没有时退回摘要里带的那份。
 */
export function mergeSessions(
  summaries: readonly SessionSummary[],
  statuses: Record<string, MirroredStatus>,
  now: number = Date.now(),
  programs: Readonly<Record<string, ProgramStatus>> = {},
): SessionRow[] {
  return summaries
    .map((summary) => {
      const key = scoped(summary.nodeId);
      const status = statuses[key];
      const fresher =
        status !== undefined &&
        millis(status.updatedAt) >= millis(summary.updatedAt);
      const updatedAt = fresher ? status.updatedAt : summary.updatedAt;
      const activity = newerActivity(summary.activity, status?.activity);
      const program = summary.alive
        ? (programs[key] ?? summary.programStatus)
        : undefined;
      const interrupted = fresher ? status.interrupted : summary.interrupted;
      const stateSource = fresher ? status.stateSource : summary.stateSource;
      return {
        nodeId: summary.nodeId,
        boardId: summary.boardId,
        sessionId: summary.sessionId,
        title: summary.title,
        cwd: summary.cwd,
        agentId: status?.agentId ?? summary.agentId,
        state: fresher ? status.state : summary.state,
        ...(stateSource ? { stateSource } : {}),
        unread: fresher ? status.unread : summary.unread,
        pendingId: fresher ? status.pendingId : summary.pendingId,
        ...optionalErrored(fresher ? status.errored : summary.errored),
        ...(interrupted === undefined ? {} : { interrupted }),
        ...(fresher && status.restored ? { restored: true } : {}),
        ...(activity ? { activity } : {}),
        ...(program ? { program } : {}),
        sessionPhase: fresher ? status.sessionPhase : summary.sessionPhase,
        updatedAt,
        alive: summary.alive,
        ...(summary.backend ? { backend: summary.backend } : {}),
        sinceMs: Math.max(0, now - millis(updatedAt)),
      } satisfies SessionRow;
    })
    .sort(byRecency);
}

/** 最近变更在前；时间相同再按标题稳定排序。 */
export function byRecency(a: SessionRow, b: SessionRow): number {
  const diff = millis(b.updatedAt) - millis(a.updatedAt);
  return diff !== 0 ? diff : a.title.localeCompare(b.title);
}

/** 状态模式分区：固定顺序，空区不返回。 */
export function groupSessionsByStatus(
  rows: readonly SessionRow[],
): SessionSection[] {
  const sections = new Map<SessionBucket, SessionRow[]>();
  for (const row of rows) {
    const bucket = sessionBucket(row);
    const list = sections.get(bucket) ?? [];
    list.push(row);
    sections.set(bucket, list);
  }
  return SESSION_BUCKETS.filter((bucket) => sections.has(bucket)).map(
    (bucket) => ({
      bucket,
      rows: [...sections.get(bucket)!].sort(byRecency),
    }),
  );
}

/** 过滤框：标题与目录，大小写不敏感。 */
export function filterSessions(
  rows: readonly SessionRow[],
  query: string,
): SessionRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.cwd.toLowerCase().includes(needle),
  );
}

/** 目录名，会话行第二行用。 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** 只为了让「处于该状态多久」跟着走的重渲染节拍。 */
function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

export interface UseSessionsResult {
  sessions: SessionRow[];
  isPending: boolean;
  refresh: () => void;
}

/**
 * 会话列表的查询（侧栏与镜像补齐共用一份缓存）：键与请求绑在同一个源上——
 * 键是渲染时的源，请求也发往它，不随之后的当前源漂走。
 */
export function sessionsQuery(workspaceId: string | null) {
  const sourceId = activeSourceId();
  return {
    queryKey: srcKey(sourceId, "sessions", workspaceId),
    queryFn: () => sourceApi(sourceById(sourceId)).sessions(workspaceId!),
    enabled: Boolean(workspaceId),
    retry: false,
  } as const;
}

export function useSessions(workspaceId: string | null): UseSessionsResult {
  const query = useQuery(sessionsQuery(workspaceId));
  const statuses = useAgentStatusStore((state) => state.statuses);
  const programs = useProgramStatusStore((state) => state.programs);
  const tick = useTick(5_000);

  // 镜像补齐不在这里。它跟着应用挂载走（`useAgentStatusHydration`），
  // 否则画布上的节点徽标会取决于侧栏挂没挂。
  const sessions = useMemo(
    () => mergeSessions(query.data ?? [], statuses, Date.now(), programs),
    // `tick` 只是节拍源，故意进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.data, statuses, programs, tick],
  );

  return {
    sessions,
    isPending: query.isPending && Boolean(workspaceId),
    refresh: () => void query.refetch(),
  };
}
