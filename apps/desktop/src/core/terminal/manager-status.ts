import type { DatabaseSync } from "node:sqlite";
import { getAgentStatus } from "../agent/status";
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
export function authorizeDrive(
  drive: DriveBook,
  record: SessionRecord,
  writer: TerminalWriter | undefined,
): void {
  const sessionId = record.id;
  const takeover =
    drive.creator(sessionId) !== undefined &&
    (writer?.principalId ?? "") !== drive.creator(sessionId);
  if (
    !drive.permits(sessionId, writer, (workspaceId) =>
      allows([scope("terminal:drive", workspaceId)]),
    )
  ) {
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

/** The existing state/lease snapshot, kept separate from PTY lifecycle mutation. */
export function driveTargetFor(
  database: DatabaseSync,
  nodeId: string,
  generation: (id: string) => number | undefined,
  lease: (id: string) => Lease,
): DriveTarget {
  const sessionId = loadSession(database, nodeId)?.sessionId;
  const live = sessionId === undefined ? undefined : generation(sessionId);
  const status = getAgentStatus(database, nodeId);
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
