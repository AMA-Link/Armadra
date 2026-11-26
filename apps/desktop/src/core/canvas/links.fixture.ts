import type { DatabaseSync } from "node:sqlite";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { compileBoardLinks, notifyContextLinksChanged } from "./context-links";

function recompile(database: DatabaseSync, boardId: string): void {
  const board = database
    .prepare("SELECT workspace_id FROM boards WHERE id = ?")
    .get(boardId) as { workspace_id: string };
  for (const id of compileBoardLinks(database, boardId)) {
    notifyContextLinksChanged(board.workspace_id, id);
  }
}

/**
 * Test helper: draws (or re-roles) the edge `source → target` on the source
 * node's board and recompiles that board's link documents, as a board save
 * would (Armadra#1062 S1). Link documents have no other writer for node links,
 * so a test that wants two nodes linked draws the edge.
 */
export function linkNodes(
  database: DatabaseSync,
  source: string,
  target: string,
  role: "peer" | "supervises" = "peer",
): void {
  const row = database
    .prepare("SELECT board_id FROM nodes WHERE id = ?")
    .get(source) as { board_id: string } | undefined;
  if (row === undefined) throw new Error(`no node ${source}`);
  const existing = database
    .prepare(
      "SELECT id FROM edges WHERE (source_node_id = ? AND target_node_id = ?) " +
        "OR (source_node_id = ? AND target_node_id = ?)",
    )
    .get(source, target, target, source) as { id: string } | undefined;
  const now = rfc3339();
  if (existing === undefined) {
    database
      .prepare(
        "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, role, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 'link', ?, ?, ?)",
      )
      .run(uuidV7(), row.board_id, source, target, role, now, now);
  } else {
    database
      .prepare(
        "UPDATE edges SET source_node_id = ?, target_node_id = ?, role = ?, updated_at = ? WHERE id = ?",
      )
      .run(source, target, role, now, existing.id);
  }
  recompile(database, row.board_id);
}

/** Test helper: removes every edge between the two nodes and recompiles. */
export function unlinkNodes(
  database: DatabaseSync,
  a: string,
  b: string,
): void {
  const row = database
    .prepare("SELECT board_id FROM nodes WHERE id = ?")
    .get(a) as { board_id: string } | undefined;
  if (row === undefined) throw new Error(`no node ${a}`);
  database
    .prepare(
      "DELETE FROM edges WHERE (source_node_id = ? AND target_node_id = ?) " +
        "OR (source_node_id = ? AND target_node_id = ?)",
    )
    .run(a, b, b, a);
  recompile(database, row.board_id);
}
