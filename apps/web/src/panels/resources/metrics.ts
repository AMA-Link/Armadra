/**
 * 指标格式化（T02，终端宿主设计 §8）。
 *
 * 这一层只有一条规则：**`null` 是一个值，不是 0**。Runtime 对测不出来的
 * 指标发 `null`，这里一律渲染成短横线；把它当 0 显示会变成「这台机器很
 * 闲」——那是另一句话，而且是假话。
 *
 * 所以每个 `format*` 都接受 `number | null | undefined`，并且只有拿到有限
 * 数值时才格式化。
 */
import { formatBytes } from "@/lib/format";
import type {
  CanvasNode,
  HostResources,
  PlatformComponent,
  ProcessSample,
  ResourceUnknownReason,
  SessionResources,
} from "@armadra/shared";
import type { SessionRow } from "@/agent/sessions";

/** 测不出来时显示的东西。整个面板只有这一个占位符。 */
export const UNKNOWN = "—";

export function formatMetricBytes(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatBytes(value)
    : UNKNOWN;
}

/** 百分比保留一位小数，整数不带 `.0`。 */
export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNKNOWN;
  const rounded = value.toFixed(1).replace(/\.0$/, "");
  return `${rounded}%`;
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : UNKNOWN;
}

export function formatLoad(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : UNKNOWN;
}

/** 运行时长：`3 天 4 小时` / `5 小时 12 分` / `40 分`。 */
export function formatUptime(
  seconds: number | null | undefined,
  labels: { day: string; hour: string; minute: string },
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return UNKNOWN;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}${labels.day} ${hours}${labels.hour}`;
  if (hours > 0) return `${hours}${labels.hour} ${minutes}${labels.minute}`;
  return `${minutes}${labels.minute}`;
}

/**
 * 内存已用比例。
 *
 * 刻意只在 total 与 used 都有的时候才算：缺一个就是 `null`，因为
 * 「已用比例」是从两个数推出来的，推不出来就不该猜。
 *
 * 设计 §8 还要求它与「内存压力」分开——已用比例高不等于系统有压力，
 * 所以这里只回一个比例，不回任何压力判断。
 */
export function memoryUsedPercent(host: HostResources): number | null {
  const { totalBytes, usedBytes } = host.memory;
  if (typeof totalBytes !== "number" || totalBytes <= 0) return null;
  if (typeof usedBytes !== "number") return null;
  return (usedBytes / totalBytes) * 100;
}

/** 磁盘已用比例，同样是两个数都在才算。 */
export function diskUsedPercent(host: HostResources): number | null {
  const disk = host.disk;
  if (!disk) return null;
  const { totalBytes, availableBytes } = disk;
  if (typeof totalBytes !== "number" || totalBytes <= 0) return null;
  if (typeof availableBytes !== "number") return null;
  return ((totalBytes - availableBytes) / totalBytes) * 100;
}

/** 会话表格默认按 CPU 从高到低；测不出来的排在最后，而不是当 0 混进来。 */
export type SessionSort = "cpu" | "memory" | "name";

/**
 * 排序只换看的顺序。并列（尤其是都测不出来的）按名字、再按会话 id 定先后：
 * 没有这一步，每一拍采样都可能让并列的几行互换位置，列表看起来在抖。
 */
export function sortSessions(
  sessions: readonly SessionResources[],
  sort: SessionSort,
  titleOf: (session: SessionResources) => string,
): SessionResources[] {
  const rows = [...sessions];
  const byName = (left: SessionResources, right: SessionResources) =>
    titleOf(left).localeCompare(titleOf(right)) ||
    left.sessionId.localeCompare(right.sessionId);
  if (sort === "name") return rows.sort(byName);
  const key = sort === "cpu" ? "cpuPercent" : "memoryBytes";
  return rows.sort((left, right) => {
    const a = left[key];
    const b = right[key];
    const aKnown = typeof a === "number";
    const bKnown = typeof b === "number";
    if (aKnown && bKnown && a !== b) return b - a;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return byName(left, right);
  });
}

/** 一个会话在列表里怎么称呼：节点标题为主，Agent 与画板是副标注。 */
export interface SessionIdentity {
  /** 节点标题；查不到时是 `null`，由界面写一个中性的占位，而不是退到目录名。 */
  readonly title: string | null;
  readonly agentId: string | undefined;
  /** 只在会话不在当前画板、且工作空间有多块画板时才有。 */
  readonly boardName: string | undefined;
  readonly boardId: string | undefined;
  readonly nodeId: string | null;
}

/**
 * 会话 → 标题 / Agent / 画板。
 *
 * 来源按可靠程度：工作空间的会话读模型（覆盖**所有画板**，标题是节点当前的名字），
 * 然后是当前画板的节点。**不**退到 `cwd` 的末级目录：一块工作空间里的终端几乎都
 * 开在同一个根目录，那样每一组都叫同一个名字（默认工作空间的根就叫 `default`）。
 */
export function sessionIdentity(
  session: SessionResources,
  rows: readonly SessionRow[] | undefined,
  nodes: readonly CanvasNode[] | undefined,
  boards: readonly { id: string; name: string }[],
  activeBoardId: string | undefined,
): SessionIdentity {
  const row =
    (session.nodeId === null
      ? undefined
      : rows?.find((entry) => entry.nodeId === session.nodeId)) ??
    rows?.find((entry) => entry.sessionId === session.sessionId);
  const nodeId = session.nodeId ?? row?.nodeId ?? null;
  const node =
    nodeId === null ? undefined : nodes?.find((entry) => entry.id === nodeId);
  const title = row?.title ?? node?.title ?? null;
  const agentId =
    row?.agentId ??
    (node?.data.kind === "terminal" ? node.data.agent?.id : undefined);
  const boardId = row?.boardId ?? node?.boardId;
  const boardName =
    boards.length > 1 && boardId !== undefined && boardId !== activeBoardId
      ? boards.find((entry) => entry.id === boardId)?.name
      : undefined;
  return { title, agentId, boardName, boardId, nodeId };
}

export interface TreeRow {
  readonly process: ProcessSample;
  readonly depth: number;
}

/**
 * 把平铺的子进程按父子关系排成一棵树：同级里 Armadra 自己的进程（钩子、画布
 * 工具 MCP）排在最后，其余按内存从高到低。父进程不在列表里（被截掉、或者已经
 * 退出）的挂在最上层，所以截断不会让谁凭空消失。
 */
export function orderProcessTree(
  processes: readonly ProcessSample[],
  leaderPid: number | null,
): TreeRow[] {
  const known = new Set(processes.map((entry) => entry.pid));
  const rank = (left: ProcessSample, right: ProcessSample) =>
    Number(left.origin === "armadra") - Number(right.origin === "armadra") ||
    (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0) ||
    left.pid - right.pid;
  const byParent = new Map<number, ProcessSample[]>();
  const top: ProcessSample[] = [];
  for (const entry of processes) {
    const parent = entry.parentPid;
    if (parent === null || parent === leaderPid || !known.has(parent)) {
      top.push(entry);
      continue;
    }
    const siblings = byParent.get(parent);
    if (siblings === undefined) byParent.set(parent, [entry]);
    else siblings.push(entry);
  }
  const rows: TreeRow[] = [];
  const seen = new Set<number>();
  const visit = (entry: ProcessSample, depth: number) => {
    if (seen.has(entry.pid)) return;
    seen.add(entry.pid);
    rows.push({ process: entry, depth });
    for (const child of (byParent.get(entry.pid) ?? []).sort(rank)) {
      visit(child, depth + 1);
    }
  };
  for (const entry of top.sort(rank)) visit(entry, 0);
  // 父子成环（一张在遍历中变过的表）时，没走到的挂在最上层。
  for (const entry of processes) visit(entry, 0);
  return rows;
}

/** `unknownReason` → i18n 键；`null`（有数字）时不显示任何徽标。 */
export function unknownReasonKey(
  reason: ResourceUnknownReason | null,
): string | null {
  return reason === null ? null : `resources.unknown.${reason}`;
}

/**
 * 进程已经不在的会话不进列表：Runtime 采样时就不返回它们，这里再挡一道，
 * 免得旧 Runtime 或远端主机回来的快照又把「已退出 / 进程已经不在了」这样
 * 一整行短横线塞进面板。会话结束就消失，不留占位。
 *
 * 跑丢的会话由「孤立会话」区块单独负责，那份列表不经过这里。
 */
const GONE_REASONS: ReadonlySet<ResourceUnknownReason> = new Set([
  "exited",
  "not-found",
]);

export function liveSessions(
  sessions: readonly SessionResources[],
): SessionResources[] {
  return sessions.filter(
    (session) =>
      // 节能休眠的会话进程不在，但节点还挂着它、点一下就接回来：照列，写明
      // 「已休眠」，数字恒为空（宿主设计 §7.2）。
      session.unknownReason === "hibernated" ||
      (session.alive &&
        !(
          session.unknownReason !== null &&
          GONE_REASONS.has(session.unknownReason)
        )),
  );
}

/* ------------------------------- 执行主机 --------------------------------- */

/**
 * 一个会话跑在哪台执行主机上。
 *
 * core 认得出来时直接在采样里给（`executionHostId`，读的是终端节点的
 * `ssh.hostId` 加工作空间绑定）。更旧的 core 不给，那时按画布推断：终端节点的
 * `ssh.hostId`，或者工作空间自己的执行主机。判定顺序是
 * **core → 节点覆盖 → 工作空间 → 本机**。
 *
 * 判不出来时返回 `null`，界面归到「未知主机」——不默认算本机：一个远程会话
 * 被算成本机，比说不知道更糟。
 */
export const LOCAL_HOST = "local";

export function executionHostOf(
  session: SessionResources,
  nodes: readonly CanvasNode[] | undefined,
  workspaceExecutionHostId: string | undefined,
): string | null {
  if (
    session.location === "remote" &&
    session.executionHostId !== "" &&
    session.executionHostId !== LOCAL_HOST
  ) {
    return session.executionHostId;
  }
  // core 明说在本机：进程就在本机进程表里（绑定了执行主机的工作空间里，
  // 普通终端节点起的也是本机 shell），不能再按工作空间算到远端主机上。
  if (session.location !== "remote" && session.executionHostId === LOCAL_HOST) {
    return LOCAL_HOST;
  }
  const node = session.nodeId
    ? nodes?.find((candidate) => candidate.id === session.nodeId)
    : undefined;
  const override =
    node?.data.kind === "terminal" ? node.data.ssh?.hostId : undefined;
  if (override) return override;
  // 远程会话而节点已经不在（或者从来不是终端节点）时说不出是哪台机器。
  if (session.location === "remote") {
    return workspaceExecutionHostId || null;
  }
  return workspaceExecutionHostId || LOCAL_HOST;
}

/** 会话列表里出现过的执行主机，稳定排序；`null` 收敛成一个「未知」条目。 */
export function executionHosts(
  sessions: readonly SessionResources[],
  nodes: readonly CanvasNode[] | undefined,
  workspaceExecutionHostId: string | undefined,
): (string | null)[] {
  const seen = new Set<string | null>();
  for (const session of sessions)
    seen.add(executionHostOf(session, nodes, workspaceExecutionHostId));
  const known = [...seen]
    .filter((host): host is string => host !== null)
    .sort((left, right) => left.localeCompare(right));
  return seen.has(null) ? [...known, null] : known;
}

/**
 * 某个筛选下要显示哪些主机总览：全部是本机加每台远端主机，本机就是本机，一台
 * 远端主机就是它那一张；判不出来的那一组没有总览。
 */
export function hostOverviews(
  local: HostResources,
  remote: readonly HostResources[],
  host: string | null | "all",
): HostResources[] {
  if (host === "all") return [local, ...remote];
  if (host === LOCAL_HOST) return [local];
  if (host === null) return [];
  return remote.filter((entry) => entry.hostId === host);
}

/** 平台组件按执行主机过滤：本机的行没有主机 id，远端的带着。 */
export function componentsOnHost(
  components: readonly PlatformComponent[],
  host: string | null | "all",
): PlatformComponent[] {
  if (host === "all") return [...components];
  if (host === LOCAL_HOST) {
    return components.filter((component) => component.location !== "remote");
  }
  return components.filter(
    (component) =>
      component.location === "remote" && component.executionHostId === host,
  );
}

/** 按执行主机过滤；`"all"` 不过滤。 */
export function sessionsOnHost(
  sessions: readonly SessionResources[],
  host: string | null | "all",
  nodes: readonly CanvasNode[] | undefined,
  workspaceExecutionHostId: string | undefined,
): SessionResources[] {
  if (host === "all") return [...sessions];
  return sessions.filter(
    (session) =>
      executionHostOf(session, nodes, workspaceExecutionHostId) === host,
  );
}

/**
 * 空闲的会话：没有可用的进程号 / 已休眠，或者几乎不占 CPU 且没有子进程。
 * 资源面板默认把它们折起来；内存越线的永远不算空闲。
 */
export function isIdleSession(
  session: SessionResources,
  high: boolean,
): boolean {
  if (high) return false;
  // 远端会话本机测不到指标，不是空闲：留在列表里。
  if (session.unknownReason === "remote") return false;
  if (session.unknownReason !== null) return true;
  return (session.cpuPercent ?? 0) < 1 && session.childCount === 0;
}
