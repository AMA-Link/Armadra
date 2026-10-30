import { validTaskId } from "../collab/control/wait";

/**
 * `runner_done` on `/hook/ama`: one round of a canvas runner the coordinator
 * started ended (host-api 1.1 `runners.onDone`, contract §15.5). It says
 * nothing about the coordinator node's own state, so it never reaches the
 * reducer; ingest turns it into the core-internal `runner.done` bus event and
 * `workflow/task-watch.ts` settles the task row without waiting for its sweep.
 */
export const RUNNER_DONE_EVENT = "runner_done";

/** ama's `SubagentStatus` values a round can end with. */
const STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "aborted",
  "max_turns",
  "interrupted",
]);

export interface RunnerDone {
  /** The board's task key (`workflow_task_runs.task_id`). */
  readonly taskId: string;
  readonly round: number;
  readonly status: string;
}

/** The report's fields, or `undefined` for a payload that is not one. */
export function readRunnerDone(payload: unknown): RunnerDone | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  const name = value.hookEventName ?? value.hook_event_name;
  if (name !== RUNNER_DONE_EVENT) return undefined;
  const taskId = value.taskId;
  const round = value.round;
  const status = value.status;
  if (typeof taskId !== "string" || !validTaskId(taskId)) return undefined;
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
    return undefined;
  }
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  return { taskId, round, status };
}

/** Whether this payload names `runner_done` at all (valid or not). */
export function isRunnerDone(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return (value.hookEventName ?? value.hook_event_name) === RUNNER_DONE_EVENT;
}
