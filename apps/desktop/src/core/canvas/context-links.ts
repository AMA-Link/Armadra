import type { DatabaseSync } from "node:sqlite";
import {
  CONTENT_LINK_KIND,
  MAX_CONTEXT_LINKS,
  MAX_LINK_TITLE,
  buildNodeLinks,
  contentLinksOf,
  mergeLinkDocument,
  sameLinkDocument,
} from "@armadra/shared";
import { badRequest, isUuid, rfc3339 } from "../workspaces/support";

/**
 * The `context_links` table: the link document a node reads its collaborators
 * from, and the only thing the context-link verbs authorise against.
 *
 * Two halves, two writers (Armadra#1062 S1):
 *
 *  - node links are compiled here from `nodes` and `edges` on every board
 *    write ({@link compileBoardLinks}, called by `documents.ts::writeDocument`
 *    inside its transaction), so authorisation follows the stored graph even
 *    when no page has the board open;
 *  - content links (`kind: "shape"`) carry a whiteboard object's text and a
 *    PNG only the page can rasterise, so the page still pushes those
 *    ({@link putContentLinks}); they are stored verbatim and later handed to
 *    an agent.
 *
 * Each writer keeps the other half as stored.
 */

const LINK_STATUSES = ["pending", "ready", "error"] as const;

export interface ContextLinkContent {
  readonly status?: string;
  readonly sourceShapeId?: string;
  readonly shapeType?: string;
  readonly textTruncated?: boolean;
  readonly text?: string;
  /** Workspace-relative path, resolved inside the workspace before use. */
  readonly pngPath?: string;
}

/**
 * 对方相对于**本节点**是什么（迁移 0024 的边角色，投影到链接文档上）。
 *
 * 边上的 `role` 是有方向的一条事实（`supervises` = source 是主）；链接文档是
 * 一个节点自己的视角，所以同一条边在两端读出来是互补的两个值：主那一侧看见
 * `sub`，从那一侧看见 `main`。授权问的是这个——「我能不能把文字打进它的终端」
 * 是一个只在「我」这一侧成立的问题。
 */
export const LINK_ROLES = ["peer", "main", "sub"] as const;

export type LinkRole = (typeof LINK_ROLES)[number];

export interface ContextLink {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  /** 节点链接一定带；内容链接没有。 */
  readonly role?: LinkRole;
  readonly content?: ContextLinkContent;
}

export interface ContextLinkDocument {
  readonly nodeId: string;
  readonly links: readonly ContextLink[];
  readonly updatedAt: string;
}

function writeDocumentRow(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
  links: readonly ContextLink[],
): void {
  database
    .prepare(
      "INSERT INTO context_links (node_id, workspace_id, links_json, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, " +
        "links_json = excluded.links_json, updated_at = excluded.updated_at",
    )
    .run(nodeId, workspaceId, JSON.stringify(links), rfc3339());
}

/**
 * Recompiles the node half of every terminal node's document on one board
 * from the stored `nodes` and `edges`, keeping each document's content links.
 * Writes only the documents that changed and returns their node ids; the
 * caller notifies once its transaction has committed.
 */
export function compileBoardLinks(
  database: DatabaseSync,
  boardId: string,
): string[] {
  const board = database
    .prepare("SELECT workspace_id FROM boards WHERE id = ?")
    .get(boardId) as { workspace_id: string } | undefined;
  if (board === undefined) return [];
  const nodes = database
    .prepare(
      "SELECT id, type, title FROM nodes WHERE board_id = ? ORDER BY created_at, id",
    )
    .all(boardId) as unknown as { id: string; type: string; title: string }[];
  const edges = database
    .prepare(
      "SELECT source_node_id AS source, target_node_id AS target, role " +
        "FROM edges WHERE board_id = ? ORDER BY created_at, id",
    )
    .all(boardId) as unknown as {
    source: string;
    target: string;
    role: string | null;
  }[];
  const changed: string[] = [];
  for (const [nodeId, nodeLinks] of Object.entries(
    buildNodeLinks(nodes, edges),
  )) {
    const stored = getContextLinks(database, nodeId);
    const exists = database
      .prepare("SELECT 1 FROM context_links WHERE node_id = ?")
      .get(nodeId);
    const next = mergeLinkDocument<ContextLink>(
      nodeLinks,
      contentLinksOf(stored.links),
    );
    if (exists !== undefined && sameLinkDocument(stored.links, next)) continue;
    // A terminal with no links and no stored row needs no row: the reader
    // answers an empty document either way.
    if (exists === undefined && next.length === 0) continue;
    writeDocumentRow(database, board.workspace_id, nodeId, next);
    changed.push(nodeId);
  }
  return changed;
}

/**
 * The page's half: a node's whiteboard content links. Every link must be a
 * content link; the stored node links are kept in front of them.
 */
export function putContentLinks(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
  links: readonly ContextLink[],
): ContextLinkDocument {
  if (links.length > MAX_CONTEXT_LINKS) {
    throw badRequest("A node cannot link more than 64 other nodes");
  }
  for (const link of links) {
    if (link.kind !== CONTENT_LINK_KIND) {
      throw badRequest(
        "Only whiteboard content links are pushed; node links follow the board's edges",
      );
    }
    const content = link.content;
    if (content !== undefined && content !== null) {
      if (
        (content.status !== undefined &&
          !(LINK_STATUSES as readonly string[]).includes(content.status)) ||
        (content.sourceShapeId !== undefined &&
          content.sourceShapeId.length > 160) ||
        (content.shapeType !== undefined && content.shapeType.length > 40)
      ) {
        throw badRequest("Invalid whiteboard reference metadata");
      }
      if (
        (content.text !== undefined &&
          Buffer.byteLength(content.text, "utf8") > 20_000) ||
        (content.pngPath !== undefined &&
          Buffer.byteLength(content.pngPath, "utf8") > 4_096)
      ) {
        throw badRequest("Context link content is too large");
      }
    }
    if (
      !isUuid(link.id) ||
      link.title.length > MAX_LINK_TITLE ||
      link.role !== undefined
    ) {
      throw badRequest("Context link is invalid");
    }
  }
  const stored = getContextLinks(database, nodeId).links;
  const nodeLinks = stored.filter((link) => link.kind !== CONTENT_LINK_KIND);
  const next = mergeLinkDocument<ContextLink>(nodeLinks, links);
  if (!sameLinkDocument(stored, next)) {
    writeDocumentRow(database, workspaceId, nodeId, next);
    notifyContextLinksChanged(workspaceId, nodeId);
  }
  return getContextLinks(database, nodeId);
}

type ChangeListener = (workspaceId: string, nodeId: string) => void;
const changeListeners = new Set<ChangeListener>();

/** Atomic writers notify only after commit, never while a rollback is possible. */
export function notifyContextLinksChanged(
  workspaceId: string,
  nodeId: string,
): void {
  for (const listener of changeListeners) listener(workspaceId, nodeId);
}

/**
 * 某个节点的链接文档刚被写过。浏览器域用它决定哪些浏览器节点此刻被 Agent
 * 连着（被动旁听，`core/browser/observe.ts`）；节点被删时链接文档随之删掉，
 * 那一步由 `board.changed` 带到。返回退订函数。
 */
export function onContextLinksChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * A node with no stored document answers an empty one stamped *now*, exactly
 * as the Rust reader does: "nothing linked" is a valid answer, not a 404.
 */
export function getContextLinks(
  database: DatabaseSync,
  nodeId: string,
): ContextLinkDocument {
  const row = database
    .prepare(
      "SELECT node_id, links_json, updated_at FROM context_links WHERE node_id = ?",
    )
    .get(nodeId) as
    { node_id: string; links_json: string; updated_at: string } | undefined;
  if (row === undefined) {
    return { nodeId, links: [], updatedAt: rfc3339() };
  }
  let links: ContextLink[] = [];
  try {
    const parsed = JSON.parse(row.links_json) as unknown;
    if (Array.isArray(parsed)) links = parsed as ContextLink[];
  } catch {
    links = [];
  }
  return { nodeId: row.node_id, links, updatedAt: row.updated_at };
}

/** The request body, with the same defaults serde applies. */
export function parseContentLinks(
  body: Record<string, unknown>,
): ContextLink[] {
  const raw = body.links;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest("links must be an array");
  return raw.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw badRequest("Context link is invalid");
    }
    const link = entry as Record<string, unknown>;
    if (
      typeof link.id !== "string" ||
      typeof link.title !== "string" ||
      typeof link.kind !== "string"
    ) {
      throw badRequest("Context link is invalid");
    }
    const parsed: ContextLink = {
      id: link.id,
      title: link.title,
      kind: link.kind,
      ...(typeof link.role === "string" &&
      (LINK_ROLES as readonly string[]).includes(link.role)
        ? { role: link.role as LinkRole }
        : {}),
    };
    if (link.content === undefined || link.content === null) return parsed;
    if (typeof link.content !== "object") {
      throw badRequest("Context link is invalid");
    }
    return { ...parsed, content: link.content as ContextLinkContent };
  });
}

/**
 * 这个节点在主从结构里的位置，供 `ARMADRA_NODE_ROLE` 用（迁移 0024）。
 *
 * 头上有主就是 `sub`：那是约束它的那一条。只有从、没有主才是 `main`。两者都
 * 没有就什么都不是——`undefined`，而不是一个写成 `"peer"` 的第三种身份：一块
 * 只有对等连线的画布上，「角色」这个概念本身不适用。
 */
export function nodeRole(
  database: DatabaseSync,
  nodeId: string,
): "main" | "sub" | undefined {
  const links = getContextLinks(database, nodeId).links;
  if (links.some((link) => link.role === "main")) return "sub";
  if (links.some((link) => link.role === "sub")) return "main";
  return undefined;
}
