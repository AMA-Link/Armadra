import { type IngestContext, apply } from "./ingest";
import { STALE_WORKING_MINUTES, staleEvent, terminalGoneEvent } from "./reduce";
import {
  agentsWithDeadTerminals,
  getAgentStatus,
  staleApprovalAgents,
  staleWorkingAgents,
  upsertAgentStatus,
} from "./store";

/** How often the stale-working sweep runs. */
export const SWEEP_INTERVAL_MS = 60_000;
/**
 * At most this many nodes are closed out per sweep, so one bad session cannot
 * produce a thousand-event burst on the WebSocket.
 */
export const SWEEP_BATCH = 64;
/**
 * How long after a terminal ends before its node is closed out. A CLI's final
 * `Stop` is written on the way down and may still be in flight; the real
 * report is always better than our synthetic one.
 */
export const TERMINAL_GONE_GRACE_SECONDS = 30;

/**
 * Two ways a turn can end without anyone saying so: the CLI stopped reporting
 * ({@link STALE_WORKING_MINUTES} minutes), or its terminal died and it will
 * never report again.
 */
export function sweepOnce(context: IngestContext): number {
  const now = (context.now ?? (() => new Date()))();
  const silentSince = new Date(
    now.getTime() - STALE_WORKING_MINUTES * 60_000,
  ).toISOString();
  const goneBefore = new Date(
    now.getTime() - TERMINAL_GONE_GRACE_SECONDS * 1000,
  ).toISOString();

  const work = [
    ...staleWorkingAgents(context.database, silentSince, SWEEP_BATCH).map(
      (agent) => ({ agent, event: staleEvent(agent.nodeId, agent.agentId) }),
    ),
    ...agentsWithDeadTerminals(context.database, goneBefore, SWEEP_BATCH).map(
      (agent) => ({
        agent,
        event: terminalGoneEvent(agent.nodeId, agent.agentId),
      }),
    ),
  ];

  let closed = 0;
  for (const { agent, event } of work) {
    // The PTY is gone, so nothing is waiting for an answer any more: the
    // awaitingInput hold would otherwise rewrite this `done` to `waiting` and
    // leave the node claiming it wants input from a dead terminal.
    if (event.silent === true) {
      context.hooks.withMemory(agent.nodeId, (memory) => {
        memory.awaitingInput = false;
      });
    }
    try {
      if (
        apply(context, agent.workspaceId, agent.agentId, event, null) !==
        undefined
      ) {
        closed += 1;
      }
    } catch (error) {
      context.log.warn("could not close a stale agent", {
        node: agent.nodeId,
        error,
      });
    }
  }
  return closed;
}

/**
 * How long a permission request stays answerable. The hook client gives up
 * after `ARMADRA_PERM_WAIT_SECS` and the CLI carries on without us, so past
 * this the request id is dead: answering it can only 404. The core drops it
 * here and publishes the row, which is what every view reads (S9) — the page
 * no longer keeps a second copy with its own timer.
 */
export const APPROVAL_TTL_SECONDS = 300;

/**
 * Drops the `pendingId` of requests nobody can answer any more. The state is
 * left alone: a node that was `blocked` is still waiting for a person, only the
 * answer buttons go away.
 */
export function expireApprovalsOnce(context: IngestContext): number {
  const now = (context.now ?? (() => new Date()))();
  const before = new Date(
    now.getTime() - APPROVAL_TTL_SECONDS * 1000,
  ).toISOString();
  let expired = 0;
  for (const agent of staleApprovalAgents(
    context.database,
    before,
    SWEEP_BATCH,
  )) {
    try {
      const row = getAgentStatus(context.database, agent.nodeId);
      if (row === undefined || row.pendingId === undefined) continue;
      const status = upsertAgentStatus(
        context.database,
        {
          nodeId: row.nodeId,
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          state: row.state,
          stateSource: row.stateSource,
          unread: row.unread,
          sessionId: row.sessionId,
          pendingId: undefined,
          verified: row.verified,
          transcriptPath: row.transcriptPath,
          sessionPhase: row.sessionPhase,
          errored: row.errored,
          interrupted: row.interrupted,
          lastEventAt: undefined,
        },
        now.toISOString(),
      );
      context.bus.emit("workspace.event", {
        workspaceId: agent.workspaceId,
        event: {
          type: "agent.status",
          status: status as unknown as Readonly<Record<string, unknown>>,
        },
      });
      expired += 1;
    } catch (error) {
      context.log.warn("could not expire a pending approval", {
        node: agent.nodeId,
        error,
      });
    }
  }
  return expired;
}

/**
 * Starts the 60s sweep; returns the stop function. The timer is unref'd so it
 * never keeps the process alive on its own.
 */
export function startStaleSweep(context: IngestContext): () => void {
  const timer = setInterval(() => {
    try {
      sweepOnce(context);
      expireApprovalsOnce(context);
    } catch (error) {
      context.log.warn("the stale agent sweep failed", { error });
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
