import type { DatabaseSync } from "node:sqlite";
import { getWorkspace } from "../workspaces/table";
import { badRequest, notFound, rfc3339, uuidV7 } from "../workspaces/support";

/**
 * The `boards` table: listing, naming, creating, reordering and deleting the
 * boards of one workspace.
 *
 * A board is a canvas (`kind = 'canvas'`) or the workspace's sessions board
 * (`kind = 'sessions'`, migration 0074, Armadra#1062 S2): the home of agent
 * sessions opened from the session page rather than on a canvas. It is a
 * board like any other for loading, saving and link documents, but it is not
 * listed, renamed, reordered or deleted through the board API, and there is at
 * most one per workspace, created on first use ({@link ensureSessionBoard}).
 *
 * A port of the pre-merge implementation. `whiteboard_json` is read and
 * written but never parsed — the core only ever knows its length (see
 * `validation.ts`), which is what lets a client change the snapshot format
 * without a core release.
 */

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export interface Board {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly viewport: Viewport;
  /** Opaque; `""` means "no whiteboard yet". */
  readonly whiteboard: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BoardRow {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  viewport_json: string;
  whiteboard_json: string;
  created_at: string;
  updated_at: string;
}

const SELECT_BOARD =
  "SELECT id, workspace_id, name, sort_order, viewport_json, whiteboard_json, " +
  "created_at, updated_at FROM boards";

/**
 * A viewport that will not parse falls back to the default, for the same
 * reason the Rust reader does it: a camera position is not worth refusing to
 * open a board over.
 */
function fromRow(row: BoardRow): Board {
  let viewport = DEFAULT_VIEWPORT;
  try {
    const parsed = JSON.parse(row.viewport_json) as Partial<Viewport>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.zoom === "number"
    ) {
      viewport = { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
    }
  } catch {
    viewport = DEFAULT_VIEWPORT;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    sortOrder: Number(row.sort_order),
    viewport,
    whiteboard: row.whiteboard_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBoards(
  database: DatabaseSync,
  workspaceId: string,
): readonly Board[] {
  // The workspace read is the 404: a board list for an id nobody registered is
  // "no such workspace", not an empty list.
  getWorkspace(database, workspaceId);
  const rows = database
    .prepare(
      `${SELECT_BOARD} WHERE workspace_id = ? AND kind = 'canvas' ORDER BY sort_order, created_at`,
    )
    .all(workspaceId) as unknown as BoardRow[];
  return rows.map(fromRow);
}

/** `boards.kind` of the workspace's sessions board. */
export const SESSIONS_BOARD_KIND = "sessions";

/** Is this board a workspace's sessions board? Unknown ids answer `false`. */
export function isSessionBoard(
  database: DatabaseSync,
  boardId: string,
): boolean {
  const row = database
    .prepare("SELECT kind FROM boards WHERE id = ?")
    .get(boardId) as { kind: string } | undefined;
  return row?.kind === SESSIONS_BOARD_KIND;
}

/** The kind of the board a node is on; `undefined` for an unknown node. */
export function boardKindOfNode(
  database: DatabaseSync,
  nodeId: string,
): string | undefined {
  const row = database
    .prepare(
      "SELECT b.kind AS kind FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .get(nodeId) as { kind: string } | undefined;
  return row?.kind;
}

/** The workspace's sessions board, if it has been created. */
export function sessionBoardOf(
  database: DatabaseSync,
  workspaceId: string,
): Board | undefined {
  const row = database
    .prepare(`${SELECT_BOARD} WHERE workspace_id = ? AND kind = 'sessions'`)
    .get(workspaceId) as BoardRow | undefined;
  return row === undefined ? undefined : fromRow(row);
}

/**
 * The workspace's sessions board, created on first use. The partial unique
 * index keeps it to one per workspace even if two callers race.
 */
export function ensureSessionBoard(
  database: DatabaseSync,
  workspaceId: string,
): Board {
  getWorkspace(database, workspaceId);
  const existing = sessionBoardOf(database, workspaceId);
  if (existing !== undefined) return existing;
  const now = rfc3339();
  database
    .prepare(
      "INSERT OR IGNORE INTO boards (id, workspace_id, name, sort_order, viewport_json, kind, created_at, updated_at) " +
        "VALUES (?, ?, 'Sessions', 0, ?, 'sessions', ?, ?)",
    )
    .run(uuidV7(), workspaceId, JSON.stringify(DEFAULT_VIEWPORT), now, now);
  const created = sessionBoardOf(database, workspaceId);
  if (created === undefined) throw notFound("Board was not found");
  return created;
}

/** The board API answers the sessions board as if it did not exist. */
function getCanvasBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): Board {
  const board = getBoard(database, workspaceId, boardId);
  if (isSessionBoard(database, board.id)) {
    throw notFound("Board was not found");
  }
  return board;
}

export function getBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): Board {
  const row = database
    .prepare(`${SELECT_BOARD} WHERE id = ? AND workspace_id = ?`)
    .get(boardId, workspaceId) as BoardRow | undefined;
  if (row === undefined) throw notFound("Board was not found");
  return fromRow(row);
}

export function validateBoardName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > 80) {
    throw badRequest("Board name is invalid");
  }
  return trimmed;
}

export function createBoard(
  database: DatabaseSync,
  workspaceId: string,
  name: string,
): Board {
  getWorkspace(database, workspaceId);
  const validated = validateBoardName(name);
  const id = uuidV7();
  const now = rfc3339();
  const next = database
    .prepare(
      "SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM boards WHERE workspace_id = ? AND kind = 'canvas'",
    )
    .get(workspaceId) as { next: number };
  database
    .prepare(
      "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      workspaceId,
      validated,
      Number(next.next),
      JSON.stringify(DEFAULT_VIEWPORT),
      now,
      now,
    );
  return getBoard(database, workspaceId, id);
}

export function updateBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  patch: {
    readonly name?: string | undefined;
    readonly sortOrder?: number | undefined;
  },
): Board {
  const current = getCanvasBoard(database, workspaceId, boardId);
  const name =
    patch.name === undefined ? current.name : validateBoardName(patch.name);
  let sortOrder = current.sortOrder;
  if (patch.sortOrder !== undefined) {
    if (
      !Number.isInteger(patch.sortOrder) ||
      patch.sortOrder < 0 ||
      patch.sortOrder > 10_000
    ) {
      throw badRequest("Board order is out of range");
    }
    sortOrder = patch.sortOrder;
  }
  database
    .prepare(
      "UPDATE boards SET name = ?, sort_order = ? WHERE id = ? AND workspace_id = ?",
    )
    .run(name, sortOrder, boardId, workspaceId);
  return getBoard(database, workspaceId, boardId);
}

/**
 * Any board can go, the last one included: a workspace may have no boards, and
 * the canvas shows an empty state until one is created (contract §36).
 */
export function deleteBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): void {
  getCanvasBoard(database, workspaceId, boardId);
  database
    .prepare("DELETE FROM boards WHERE id = ? AND workspace_id = ?")
    .run(boardId, workspaceId);
}
