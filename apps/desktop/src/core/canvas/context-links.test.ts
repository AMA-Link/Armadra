import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { uuidV7 } from "../workspaces/support";
import { createWorkspace } from "../workspaces/table";
import { type Board, listBoards } from "./boards";
import {
  compileBoardLinks,
  getContextLinks,
  putContentLinks,
} from "./context-links";
import type { CanvasEdge, CanvasNode } from "./document-types";
import { saveBoard } from "./documents";
import { linkEdge, stickyNode } from "./nodes.fixture";

/**
 * Node link documents are compiled by core from the stored nodes and edges on
 * every board write (Armadra#1062 S1); the page only pushes content links.
 */
describe("compiled link documents", () => {
  let core: Fixture;
  let workspaceId: string;
  let board: Board;
  let revision: string;

  beforeEach(() => {
    core = fixture([]);
    workspaceId = createWorkspace(core.database, {
      name: "fixture",
      rootPath: core.directory,
    }).id;
    const first = listBoards(core.database, workspaceId)[0];
    if (first === undefined) throw new Error("the default board is missing");
    board = first;
    revision = board.updatedAt;
  });
  afterEach(() => {
    core.close();
  });

  function terminal(title: string): CanvasNode {
    return {
      ...stickyNode(board.id),
      type: "terminal",
      title,
      data: { kind: "terminal" },
    };
  }

  function save(nodes: CanvasNode[], edges: CanvasEdge[]): void {
    const saved = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: revision,
      nodes,
      edges,
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    revision = saved.board.updatedAt;
  }

  const links = (nodeId: string) =>
    getContextLinks(core.database, nodeId).links;

  it("gives both terminals complementary roles for a supervises edge", () => {
    const main = terminal("Planner");
    const sub = terminal("Worker");
    save(
      [main, sub],
      [{ ...linkEdge(board.id, main.id, sub.id), role: "supervises" }],
    );
    expect(links(main.id)).toEqual([
      { id: sub.id, title: "Worker", kind: "terminal", role: "sub" },
    ]);
    expect(links(sub.id)).toEqual([
      { id: main.id, title: "Planner", kind: "terminal", role: "main" },
    ]);
  });

  it("makes a plain edge a peer link on both sides", () => {
    const a = terminal("A");
    const b = terminal("B");
    save([a, b], [linkEdge(board.id, a.id, b.id)]);
    expect(links(a.id)[0]).toMatchObject({ id: b.id, role: "peer" });
    expect(links(b.id)[0]).toMatchObject({ id: a.id, role: "peer" });
  });

  it("empties both documents when the edge is removed", () => {
    const a = terminal("A");
    const b = terminal("B");
    save([a, b], [linkEdge(board.id, a.id, b.id)]);
    expect(links(a.id)).toHaveLength(1);
    save([a, b], []);
    expect(links(a.id)).toEqual([]);
    expect(links(b.id)).toEqual([]);
  });

  it("follows a rename into the peer's document", () => {
    const a = terminal("Old name");
    const b = terminal("B");
    save([a, b], [linkEdge(board.id, a.id, b.id)]);
    expect(links(b.id)[0]?.title).toBe("Old name");
    save([{ ...a, title: "New name" }, b], [linkEdge(board.id, a.id, b.id)]);
    expect(links(b.id)[0]?.title).toBe("New name");
  });

  it("compiles a document for a linked node that is not a terminal", () => {
    const a = terminal("A");
    const note = stickyNode(board.id);
    save([a, note], [linkEdge(board.id, a.id, note.id)]);
    expect(links(a.id)[0]).toMatchObject({ id: note.id, kind: "sticky" });
    // A workflow's anchor sticky sends as itself, so it needs its own document.
    expect(links(note.id)).toEqual([
      { id: a.id, title: "A", kind: "terminal", role: "peer" },
    ]);
  });

  it("writes no row for a node with no links that never had one", () => {
    const a = terminal("A");
    const note = stickyNode(board.id);
    save([a, note], []);
    expect(
      core.database
        .prepare("SELECT 1 FROM context_links WHERE node_id = ?")
        .get(note.id),
    ).toBeUndefined();
  });

  it("keeps content links through a later save", () => {
    const a = terminal("A");
    const b = terminal("B");
    save([a, b], []);
    const shape = uuidV7();
    putContentLinks(core.database, workspaceId, a.id, [
      { id: shape, title: "Sketch", kind: "shape", content: { text: "box" } },
    ]);
    save([a, b], [linkEdge(board.id, a.id, b.id)]);
    expect(links(a.id).map((link) => link.id)).toEqual([b.id, shape]);
    save([a, b], []);
    expect(links(a.id)).toEqual([
      expect.objectContaining({ id: shape, kind: "shape" }),
    ]);
  });

  it("keeps node links in front when content links are pushed", () => {
    const a = terminal("A");
    const b = terminal("B");
    save([a, b], [linkEdge(board.id, a.id, b.id)]);
    const shape = uuidV7();
    const stored = putContentLinks(core.database, workspaceId, a.id, [
      { id: shape, title: "Sketch", kind: "shape" },
    ]);
    expect(stored.links.map((link) => link.id)).toEqual([b.id, shape]);
    // Pushing an empty set clears the content half only.
    const cleared = putContentLinks(core.database, workspaceId, a.id, []);
    expect(cleared.links.map((link) => link.id)).toEqual([b.id]);
  });

  it("refuses node links and roles from the page", () => {
    const a = terminal("A");
    expect(() =>
      putContentLinks(core.database, workspaceId, a.id, [
        { id: uuidV7(), title: "B", kind: "terminal" },
      ]),
    ).toThrowError(/content links/);
    expect(() =>
      putContentLinks(core.database, workspaceId, a.id, [
        { id: uuidV7(), title: "S", kind: "shape", role: "main" },
      ]),
    ).toThrowError(/invalid/);
  });

  it("recompiling an unchanged board writes nothing", () => {
    const a = terminal("A");
    const b = terminal("B");
    save([a, b], [linkEdge(board.id, a.id, b.id)]);
    expect(compileBoardLinks(core.database, board.id)).toEqual([]);
  });
});
