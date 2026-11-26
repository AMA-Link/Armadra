import { describe, expect, it, vi } from "vitest";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

const nodeMetaStub = {
  labelKey: "node.sticky",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import {
  buildContentDocuments,
  changedDocuments,
  sameLinks,
} from "./context-links";

const stamp = "2026-09-04T00:00:00.000Z";

function node(id: string, type: CanvasNode["type"], title: string): CanvasNode {
  return {
    id,
    boardId: "board",
    type,
    title,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: type },
    createdAt: stamp,
    updatedAt: stamp,
  } as CanvasNode;
}

function document(
  edges: { source: string; target: string; role?: "peer" | "supervises" }[],
): BoardDocument {
  return {
    board: {} as BoardDocument["board"],
    nodes: [
      node("claude", "terminal", "Claude"),
      node("codex", "terminal", "Codex"),
      node("note", "sticky", "结论"),
      node("sketch", "browser", "草图"),
    ],
    edges: edges.map((edge, index) => ({
      id: `e${index}`,
      boardId: "board",
      kind: "link" as const,
      createdAt: stamp,
      updatedAt: stamp,
      ...edge,
    })),
  };
}

describe("changedDocuments", () => {
  it("只推变了的节点", () => {
    const previous = {
      claude: [{ id: "note", title: "结论", kind: "sticky" }],
      codex: [],
    };
    const next = {
      claude: [{ id: "note", title: "改过的标题", kind: "sticky" }],
      codex: [],
    };
    expect(changedDocuments(previous, next)).toEqual(["claude"]);
    expect(changedDocuments(next, next)).toEqual([]);
    // 没推过的节点一定要推一次（第一次挂载）。
    expect(changedDocuments({}, next).sort()).toEqual(["claude", "codex"]);
  });
});

/**
 * 页面只推内容链接（白板图形，`kind: "shape"`，§6.3）；节点链接由 core 按连线
 * 编译（Armadra#1062 S1，判据的单测在 `@armadra/shared` 的 link-documents）。
 */
describe("buildContentDocuments", () => {
  const SHAPE = "019ff7d1-0d12-7421-833d-2c5e8d64edaa";
  const shapeLink = {
    id: SHAPE,
    title: "架构图",
    kind: "shape",
    content: { text: "入口在 main.rs", pngPath: ".armadra/exports/x.png" },
  };

  it("终端只拿到内容链接，连线不进页面推的文档", () => {
    const documents = buildContentDocuments(
      document([{ source: "note", target: "claude" }]),
      { claude: [shapeLink] },
    );
    expect(documents.claude).toEqual([shapeLink]);
    // 没有内容链接的终端不受影响。
    expect(documents.codex).toEqual([]);
  });

  it("不是终端的节点即使连了图形也没有文档", () => {
    const documents = buildContentDocuments(document([]), {
      note: [shapeLink],
      claude: [shapeLink],
    });
    expect(documents.note).toBeUndefined();
    expect(documents.claude).toEqual([shapeLink]);
  });

  it("超过 64 条时截断（Runtime 会 400 掉整份请求）", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      ...shapeLink,
      id: `${SHAPE.slice(0, -2)}${index.toString(16).padStart(2, "0")}`,
    }));
    expect(
      buildContentDocuments(document([]), { claude: many }).claude,
    ).toHaveLength(64);
  });

  it("`sameLinks`：正文或 PNG 路径变了就要重推", () => {
    const changed = {
      ...shapeLink,
      content: { ...shapeLink.content, text: "改过了" },
    };
    expect(sameLinks([shapeLink], [shapeLink])).toBe(true);
    expect(sameLinks([shapeLink], [changed])).toBe(false);
    expect(
      changedDocuments({ claude: [shapeLink] }, { claude: [changed] }),
    ).toEqual(["claude"]);
  });
});

it("deduplicates native references by source object, not only by arrow UUID", () => {
  const documents = buildContentDocuments(document([]), {
    claude: [
      {
        id: "first",
        title: "Note",
        kind: "shape",
        content: { sourceShapeId: "shape:note", text: "note" },
      },
      {
        id: "second",
        title: "Note",
        kind: "shape",
        content: { sourceShapeId: "shape:note", text: "note" },
      },
    ],
  });
  expect(documents.claude).toHaveLength(1);
});
