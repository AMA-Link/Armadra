import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectDoc } from "../realtime/doc";
import { type BoardFixture, boardFixture } from "../realtime/realtime.fixture";
import { DomainError } from "../workspaces/support";
import { ensureSessionBoard } from "./boards";
import { getContextLinks } from "./context-links";
import type { CanvasEdge, CanvasNode } from "./document-types";
import { loadBoard, readBoard, saveBoard } from "./documents";
import { pinSession, unpinSession } from "./move";
import { linkEdge, stickyNode } from "./nodes.fixture";

/** 会话钉到画布与收回（Armadra#1062 S5），画板是实时板。 */

function agent(
  boardId: string,
  title: string,
  handle?: string,
  x = 0,
): CanvasNode {
  const node = stickyNode(boardId);
  return {
    ...node,
    type: "terminal",
    title,
    position: { x, y: 0 },
    data: {
      kind: "terminal",
      agent: { id: "claude" },
      ...(handle === undefined ? {} : { handle }),
    },
  };
}

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("钉到画布与收回", () => {
  let fx: BoardFixture;
  let sessionsId: string;
  let lead: CanvasNode;
  let worker: CanvasNode;
  let resident: CanvasNode;

  function save(
    boardId: string,
    nodes: readonly CanvasNode[],
    edges: readonly CanvasEdge[],
  ) {
    const document = loadBoard(fx.core.database, fx.workspaceId, boardId);
    saveBoard(fx.core.database, fx.workspaceId, boardId, {
      expectedUpdatedAt: document.board.updatedAt,
      nodes,
      edges,
      viewport: document.board.viewport,
    });
  }

  beforeEach(() => {
    fx = boardFixture({ idleMs: 30 });
    sessionsId = ensureSessionBoard(fx.core.database, fx.workspaceId).id;
    lead = agent(sessionsId, "Lead", "atlas");
    worker = agent(sessionsId, "Worker", "vega", 600);
    save(
      sessionsId,
      [lead, worker],
      [{ ...linkEdge(sessionsId, lead.id, worker.id), role: "supervises" }],
    );
    resident = agent(fx.board.id, "Resident", "atlas", 0);
    save(fx.board.id, [resident], []);
    // 画板是实时板，并且有活动文档。
    if (fx.hub.open(fx.workspaceId, fx.board.id, true) === undefined) {
      throw new Error("not live");
    }
  });
  afterEach(() => fx.close());

  it("整组搬到实时画板：表与文档一致，主从线跟着走，撞名加后缀", () => {
    const stale = readBoard(fx.core.database, fx.workspaceId, fx.board.id);
    const result = pinSession(
      fx.core.database,
      fx.workspaceId,
      worker.id,
      fx.board.id,
    );
    expect(new Set(result.nodeIds)).toEqual(new Set([lead.id, worker.id]));

    const canvas = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    const ids = canvas.nodes.map((node) => node.id);
    expect(ids).toEqual(
      expect.arrayContaining([resident.id, lead.id, worker.id]),
    );
    expect(canvas.edges).toHaveLength(1);
    expect(canvas.edges[0]?.role).toBe("supervises");
    const movedLead = canvas.nodes.find((node) => node.id === lead.id);
    expect((movedLead?.data as { handle?: string }).handle).toBe("atlas-2");
    expect(movedLead?.position.x).toBeGreaterThan(resident.position.x);

    const live = fx.hub.live(fx.board.id);
    if (live === undefined) throw new Error("not live");
    expect(
      projectDoc(live.doc, fx.board.id)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual([...ids].sort());
    // 再物化一次也不会把它们当成删掉。
    fx.hub.flush(live, true);
    expect(
      loadBoard(fx.core.database, fx.workspaceId, fx.board.id).nodes,
    ).toHaveLength(3);

    expect(
      loadBoard(fx.core.database, fx.workspaceId, sessionsId).nodes,
    ).toEqual([]);
    expect(
      getContextLinks(fx.core.database, worker.id).links.map((l) => l.role),
    ).toEqual(["main"]);

    // 拿着搬家前那份文档的保存答 409。
    const conflict = refusal(() =>
      saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
        expectedUpdatedAt: stale.board.updatedAt,
        nodes: stale.nodes,
        edges: stale.edges,
        viewport: stale.board.viewport,
      }),
    );
    expect(conflict.status).toBe(409);
  });

  it("收回会话板：画板的表与文档都不再有它们", () => {
    pinSession(fx.core.database, fx.workspaceId, lead.id, fx.board.id);
    const result = unpinSession(fx.core.database, fx.workspaceId, lead.id);
    expect(result.toBoardId).toBe(sessionsId);
    const canvas = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    expect(canvas.nodes.map((node) => node.id)).toEqual([resident.id]);
    const live = fx.hub.live(fx.board.id);
    if (live === undefined) throw new Error("not live");
    expect(
      projectDoc(live.doc, fx.board.id).nodes.map((node) => node.id),
    ).toEqual([resident.id]);
    const sessions = loadBoard(fx.core.database, fx.workspaceId, sessionsId);
    expect(sessions.nodes.map((node) => node.id).sort()).toEqual(
      [lead.id, worker.id].sort(),
    );
  });

  it("那一组连着非会话节点时拒绝，什么都不动", () => {
    const note = stickyNode(fx.board.id);
    const canvas = loadBoard(fx.core.database, fx.workspaceId, fx.board.id);
    // 实时板经拦截保存。
    saveBoard(fx.core.database, fx.workspaceId, fx.board.id, {
      expectedUpdatedAt: canvas.board.updatedAt,
      nodes: [...canvas.nodes, note],
      edges: [linkEdge(fx.board.id, resident.id, note.id)],
      viewport: canvas.board.viewport,
    });
    const refused = refusal(() =>
      unpinSession(fx.core.database, fx.workspaceId, resident.id),
    );
    expect(refused.code).toBe("session_has_other_links");
    expect(
      loadBoard(fx.core.database, fx.workspaceId, fx.board.id).nodes,
    ).toHaveLength(2);
  });

  it("方向不对或目标不对", () => {
    expect(
      refusal(() => unpinSession(fx.core.database, fx.workspaceId, lead.id))
        .status,
    ).toBe(400);
    expect(
      refusal(() =>
        pinSession(fx.core.database, fx.workspaceId, lead.id, sessionsId),
      ).status,
    ).toBe(404);
    expect(
      refusal(() =>
        pinSession(fx.core.database, fx.workspaceId, resident.id, fx.board.id),
      ).status,
    ).toBe(400);
  });
});
