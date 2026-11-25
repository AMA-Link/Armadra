import type { DatabaseSync } from "node:sqlite";
import { getAgentStatus, type AgentStatus } from "../agent/status";
import { STATE_SOURCE_ACP } from "../agent/state-source";
import { targetState, type ObservedActivity } from "../agent/target-state";
import { loadSession } from "../collab/nodes";
import { freeLease, type Lease } from "../drive/lease";
import type { DriveTarget, SessionRecord } from "./manager";
import type { Actor } from "../drive/lease";
import { runDeliveryBridge } from "../runs/registry";
import { TerminalError } from "./backend";
import type { DriveBook, TerminalWriter } from "./input";
import { audit } from "../identity/audit";
import { allows } from "../identity/gate";
import { scope } from "../identity/scopes";

/**
 * `terminal:drive` 的判定入口（设计 §4.4）：写入者 ≠ 会话创建者时才要这条
 * 授权。今天两者都是本机 owner，所以恒通过——入口在这里，是为了让第二个
 * principal 出现时不必重新找一遍所有写入路径。
 */
export function mayDrive(
  drive: DriveBook,
  sessionId: string,
  writer: TerminalWriter | undefined,
): boolean {
  return drive.permits(sessionId, writer, (workspaceId) =>
    allows([scope("terminal:drive", workspaceId)]),
  );
}

export function authorizeDrive(
  drive: DriveBook,
  record: SessionRecord,
  writer: TerminalWriter | undefined,
): void {
  const sessionId = record.id;
  const takeover =
    drive.creator(sessionId) !== undefined &&
    (writer?.principalId ?? "") !== drive.creator(sessionId);
  if (!mayDrive(drive, sessionId, writer)) {
    throw new TerminalError(
      403,
      "forbidden",
      "Writing into another person's terminal requires terminal:drive",
    );
  }
  if (takeover) {
    // 终端接管，设计 §4.5 的第五个审计写入点。写在这里而不是附着时：附着只
    // 是看，而接管是「有人开始替另一个人按键」，那一刻才值得记。
    audit({
      action: "terminal.drive",
      target: sessionId,
      principalId: writer?.principalId ?? "",
      workspaceId: record.workspaceId,
      detail: { creator: drive.creator(sessionId) ?? "" },
    });
  }
}

export function authorizeManagedInput(
  database: DatabaseSync,
  record: SessionRecord,
  driver: Actor | undefined,
): void {
  const run = runDeliveryBridge(database);
  if (driver?.kind === "controller") {
    if (!run)
      throw new TerminalError(
        403,
        "scope_denied",
        "Controller run authority is unavailable",
      );
    run.authorizeSession(driver.controllerId, record.id, record.generation);
  } else if (
    driver?.kind !== "human" &&
    record.ownerNodeId &&
    run?.nodeOccupied(record.ownerNodeId)
  )
    throw new TerminalError(
      409,
      "node_busy",
      "This node is occupied by a controller run",
    );
}

export function assertSubmitInput(
  database: DatabaseSync,
  record: SessionRecord,
): void {
  if (!automatedInputWritable(database, record) || record.inputSafety.pending)
    throw new TerminalError(
      409,
      "input_not_safe",
      "The target is waiting for input or has a partial input line",
    );
}

/**
 * 这一行状态是不是上一个驱动留下的：状态来源是 `acp`、而节点当前的会话后端不是
 * ACP（切到终端之后，旧的 ACP 报告还在库里）。那条 `idle` 说的是别的会话，终端里
 * 的 CLI 没有报过任何东西，所以对投递门来说等于「没报过」（`agent/target-state.ts`
 * 第 3 条规矩）。对没有状态来源的 CLI（无注入的内置，契约 §120）这是唯一的拦法：
 * 它们的终端永远不会写出新的上报把旧行盖掉。
 */
export function statusOfCurrentDriver(
  status: AgentStatus | undefined,
  backendKind: string | undefined,
): AgentStatus | undefined {
  if (status === undefined) return undefined;
  if (status.stateSource === STATE_SOURCE_ACP && backendKind !== "acp") {
    return undefined;
  }
  return status;
}

/**
 * 这个节点**当前驱动**写下的状态行（已过 {@link statusOfCurrentDriver}）。投递门
 * （`driveTarget`）、队泵的快探（`silentStarter`）与首投放行门都问它，口径只有
 * 这一份：读原始的 `agent_status` 会把上一个驱动留下的行当成这个驱动报的。
 */
export function currentDriverStatus(
  database: DatabaseSync,
  nodeId: string,
  sessionId: string | undefined = loadSession(database, nodeId)?.sessionId,
): AgentStatus | undefined {
  const backendKind =
    sessionId === undefined
      ? undefined
      : (
          database
            .prepare("SELECT backend_kind FROM terminal_sessions WHERE id = ?")
            .get(sessionId) as { backend_kind?: string } | undefined
        )?.backend_kind;
  return statusOfCurrentDriver(getAgentStatus(database, nodeId), backendKind);
}

/** The existing state/lease snapshot, kept separate from PTY lifecycle mutation. */
export function driveTargetFor(
  database: DatabaseSync,
  nodeId: string,
  generation: (id: string) => number | undefined,
  lease: (id: string) => Lease,
): DriveTarget {
  const sessionId = loadSession(database, nodeId)?.sessionId;
  const live = sessionId === undefined ? undefined : generation(sessionId);
  const status = currentDriverStatus(database, nodeId, sessionId);
  const currentLease =
    sessionId === undefined ? freeLease(0) : lease(sessionId);
  return {
    nodeId,
    ...(sessionId === undefined ? {} : { sessionId }),
    state: targetState(status, live),
    ...(status?.stateSource === undefined
      ? {}
      : { stateSource: status.stateSource }),
    lease: currentLease,
    driveGeneration: currentLease.generation,
  };
}

/** Observation is a delivery gate input, never evidence of task completion. */
export function observedActivityFor(
  record: SessionRecord | undefined,
): ObservedActivity | undefined {
  if (!record || record.exited) return undefined;
  return {
    pending: record.inputSafety.pending,
    lastInputAt: record.lastActivity,
    lastOutputAt: record.lastActivity,
    startedAt: record.startedAt,
  };
}

/** Programmatic input cannot answer a permission or input question. */
export function automatedInputWritable(
  database: DatabaseSync,
  record: SessionRecord | undefined,
): boolean {
  if (!record || record.exited) return false;
  if (record.ownerNodeId === null) return true;
  const row = database
    .prepare("SELECT state FROM agent_status WHERE node_id = ?")
    .get(record.ownerNodeId) as { state?: string } | undefined;
  return row?.state !== "blocked" && row?.state !== "waiting";
}
