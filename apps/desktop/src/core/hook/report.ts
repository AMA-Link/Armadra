import {
  AGENT_STATE_SOURCES,
  stateSourceIsReported,
} from "../agent/state-source";
import { baseAgent } from "./capabilities";
import {
  type IngestContext,
  type TerminalBinding,
  apply,
  drawBinding,
  settleReport,
} from "./ingest";
import type { AgentEvent } from "./normalize";
import { type AgentStatusRow, findNodeOwner } from "./store";

/**
 * core 自己产出的状态上报入口（审查 P1-4）。
 *
 * 不是 HTTP：状态来自 core 内部读到的东西（ACP 会话、将来按进程读 CLI 自己写
 * 的会话文件），没有 `armadra-hook` 客户端、没有节点令牌可验。三类调用方现在
 * 各走各的：HTTP 的 `ingest`、ACP 的裸 `apply`、巡检的 `apply`。这里是第四条
 * 的统一口，做三件事，顺序与 `ingest` 一致：
 *
 *   1. `apply`：归约、落库、发事件；
 *   2. 时间线门铃：`apply` 本身不敲（`onHook` 只在 `ingest` 里调），而状态读取槽
 *      的事件正是要让转录尾读器读一次；
 *   3. 可选地自造终端绑定（契约 §57.2 的 `allocateSourceRevision`），让带运行
 *      关联的上报能写 `run_reports`。绑定与 `ingest` 同一套闸：必须是这个节点
 *      正在跑的、属于这个 agent 的终端会话。
 *
 * 信任：来源由调用方在事件上写死（`event.stateSource`），客户端无从自称；
 * 来源必须是词汇表里的值。上报级的来源（{@link stateSourceIsReported}）按已验证
 * 记，观察级（`observed`）不验证、也不满足任何一道门。
 */

export interface InternalReport {
  readonly nodeId: string;
  /** 节点的 agent id；与节点自己的 base 不一致的上报被丢弃（同 `ingest`）。 */
  readonly agentId: string;
  /** 归一化后的事件，`stateSource` 由调用方写。 */
  readonly event: AgentEvent;
  /** 原始载荷，只进审批记录。 */
  readonly rawPayload?: unknown;
  /** 自造绑定：调用方只给它知道的终端会话，修订号由 core 抽。 */
  readonly terminalSession?: {
    readonly sessionId: string;
    readonly generation: number;
  };
}

export function reportInternal(
  context: IngestContext,
  report: InternalReport,
): AgentStatusRow | undefined {
  const { nodeId, agentId, event } = report;
  const source = event.stateSource;
  if (
    source === undefined ||
    !(AGENT_STATE_SOURCES as readonly string[]).includes(source)
  ) {
    context.log.warn("内部上报没有写来源，丢弃", { nodeId });
    return undefined;
  }
  const owner = findNodeOwner(context.database, nodeId);
  if (owner === undefined) return undefined;
  if (
    owner.agentId !== undefined &&
    baseAgent(owner.agentId) !== baseAgent(agentId)
  ) {
    context.log.debug("内部上报来自节点之外的 CLI，丢弃", {
      nodeId,
      agentId,
      node: owner.agentId,
    });
    return undefined;
  }

  const verified = stateSourceIsReported(source);
  event.verified = verified;
  let binding: TerminalBinding | undefined;
  if (report.terminalSession !== undefined && verified) {
    const drawn = drawBinding(context, nodeId, agentId, report.terminalSession);
    // 闸没过：整条丢掉，与 `ingest` 对不合格绑定的处理一致。
    if (drawn === "refused") return undefined;
    binding = drawn;
  }
  const status = apply(
    context,
    owner.workspaceId,
    agentId,
    event,
    report.rawPayload ?? null,
  );
  settleReport(context, {
    nodeId,
    agentId,
    event,
    payload: report.rawPayload ?? null,
    verified,
    binding,
  });
  return status;
}

/* ------------------------------ 装配的那一个 ------------------------------ */

let installed: IngestContext | undefined;

/** `hook/index.ts` 装配时登记；core 里没有 HTTP 的来源（读取槽）经 {@link internalReporter} 取。 */
export function installInternalReporter(
  context: IngestContext | undefined,
): void {
  installed = context;
}

/** 装配过的上报口；没装配（用例、只起部分域的构建）时 `undefined`。 */
export function internalReporter():
  ((report: InternalReport) => AgentStatusRow | undefined) | undefined {
  const context = installed;
  return context === undefined
    ? undefined
    : (report) => reportInternal(context, report);
}
