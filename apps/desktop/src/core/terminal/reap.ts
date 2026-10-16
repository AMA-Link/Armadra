import type { DatabaseSync } from "node:sqlite";

import type { BackendKind, SessionKey, TerminalBackend } from "./backend";

/**
 * Ending sessions that a persistent backend would otherwise keep (`quit.ts`).
 *
 * Every live session is terminated through its backend first, then the backend
 * is asked to take down whatever hosts them (`reapAll`: tmux's server, with
 * the process trees of every pane it holds, including panes no row names). The
 * rows are settled last, by kind, so one that this core never adopted does not
 * stay `running` behind a server that no longer exists.
 */
export async function reapPersistent(
  database: DatabaseSync,
  backend: TerminalBackend,
  kind: BackendKind,
  live: readonly { readonly key: SessionKey }[],
  now: string,
): Promise<void> {
  for (const { key } of live) {
    try {
      await backend.terminate(key, "session");
    } catch {
      // Already gone; the sweep below settles its row.
    }
  }
  try {
    await backend.reapAll?.();
  } catch {
    // The host is unreachable: nothing left that this process can end.
  }
  database
    .prepare(
      `UPDATE terminal_sessions
          SET status = 'exited', attach_state = 'exited', ended_at = COALESCE(ended_at, ?)
        WHERE backend_kind = ? AND status = 'running'`,
    )
    .run(now, kind);
}

/** The sweep's no-record case: destroy by the row's own backend handle. */
export async function destroyRowBackend(
  database: DatabaseSync,
  backends: ReadonlyMap<BackendKind, TerminalBackend>,
  sessionId: string,
): Promise<void> {
  const row = database
    .prepare(
      "SELECT backend_ref, backend_kind FROM terminal_sessions WHERE id = ?",
    )
    .get(sessionId) as
    | { backend_ref?: string | null; backend_kind?: string }
    | undefined;
  const backend = backends.get(row?.backend_kind as BackendKind);
  if (backend === undefined || !row?.backend_ref) return;
  try {
    await backend.destroyByReference(row.backend_ref);
  } catch {
    // Unreachable is the same as gone for the purposes of a sweep.
  }
}
