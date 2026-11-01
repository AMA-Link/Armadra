/**
 * Does this workspace exist — and is it not archived (契约 §89)? An archived
 * workspace is not there to watch: its subscriptions answer `not_found` like a
 * removed one, and restoring it is what brings them back.
 *
 * The event stream's only question about another domain's data, asked before
 * the upgrade because that is where the pre-merge implementation asks it:
 * `db::get_workspace(&state.pool, &workspace_id).await?` runs first, and a
 * missing workspace becomes a `NotFound` — an HTTP 404 with the usual
 * `{ code, message }` body — rather than a socket that opens and then closes.
 *
 * The difference matters to the front end in one specific way. `api/events.ts`
 * resets its backoff in `onopen`, so a socket that opened before being dropped
 * would reconnect at the 1 s floor forever; a refusal that never opens keeps
 * the backoff climbing to its 10 s ceiling. Same outcome, very different load.
 *
 * A missing `workspaces` table answers "no". That is the honest reading during
 * assembly, and it degrades the way a client can survive: 404, backoff, retry.
 */

import type { DatabaseSync } from "node:sqlite";

export function workspaceExists(
  database: DatabaseSync,
  workspaceId: string,
): boolean {
  if (workspaceId.length === 0) return false;
  try {
    const row = database
      .prepare("SELECT 1 FROM workspaces WHERE id = ? AND archived_at IS NULL")
      .get(workspaceId);
    return row !== undefined;
  } catch {
    return false;
  }
}
