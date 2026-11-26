import type { BoardDocument, CanvasEdge, CanvasNode } from "@armadra/shared";

import type { SessionRow } from "@/agent/sessions";

const STAMP = "2026-11-26T10:00:00.000Z";

export function agentNode(
  id: string,
  boardId: string,
  options: {
    title?: string;
    agent?: string;
    driver?: "terminal" | "acp";
    sessionId?: string;
  } = {},
): CanvasNode {
  return {
    id,
    boardId,
    type: "terminal",
    title: options.title ?? id,
    color: "default",
    position: { x: 0, y: 0 },
    labels: [],
    data: {
      kind: "terminal",
      agent: {
        id: options.agent ?? "claude",
        ...(options.driver ? { driver: options.driver } : {}),
      },
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    },
  } as unknown as CanvasNode;
}

export function plainTerminal(id: string, boardId: string): CanvasNode {
  return {
    id,
    boardId,
    type: "terminal",
    title: id,
    color: "default",
    position: { x: 0, y: 0 },
    labels: [],
    data: { kind: "terminal" },
  } as unknown as CanvasNode;
}

export function supervises(
  boardId: string,
  source: string,
  target: string,
): CanvasEdge {
  return {
    id: `${source}>${target}`,
    boardId,
    source,
    target,
    kind: "link",
    role: "supervises",
    createdAt: STAMP,
    updatedAt: STAMP,
  } as CanvasEdge;
}

export function document(
  boardId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[] = [],
  updatedAt = STAMP,
): BoardDocument {
  return {
    board: {
      id: boardId,
      workspaceId: "w1",
      name: boardId,
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: STAMP,
      updatedAt,
    },
    nodes,
    edges,
  } as BoardDocument;
}

export function row(
  nodeId: string,
  patch: Partial<SessionRow> = {},
): SessionRow {
  return {
    nodeId,
    boardId: "b1",
    sessionId: `s-${nodeId}`,
    title: nodeId,
    cwd: "/repo",
    agentId: "claude",
    unread: false,
    updatedAt: STAMP,
    alive: true,
    sinceMs: 0,
    ...patch,
  };
}
