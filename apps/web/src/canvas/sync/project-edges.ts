import type {
  BoardDocument,
  CanvasEdge,
  CanvasEdgeRole,
} from "@armadra/shared";

import {
  toItemId,
  type Reference,
  type WhiteboardDoc,
} from "../whiteboard/model";

/**
 * 文档 → 连线（`board/edge-adapter.ts` 把结果写进引擎场景）。
 *
 * 纯函数：`canvas-store` 的 `document` 与 `whiteboard` 进来，边列表出去。
 * 节点 id 就是 `nodes` 行的 uuid，边 id 就是 `edges` 行的 uuid，白板对象是
 * `wb:<uuid>`；删除分流按前缀判断（`tools.ts`）。
 */

/**
 * 一条连线：上下文连线（`link`，`data` 携带唯一一样东西——两端是对等还是主从，
 * `source` 是主）或内容引用（`reference`，来源端是白板对象或 Frame）。
 */
export interface ProjectedEdge {
  id: string;
  type: "link" | "reference";
  source: string;
  target: string;
  data?: { role?: CanvasEdgeRole };
}

/**
 * 投影要的全部文档输入：两张表，没有 `board`——调用方可以只订阅这两个数组。
 * `BoardDocument` 仍然可以直接传进来，它是这个形状的超集。
 */
export type CanvasTables = Pick<BoardDocument, "nodes" | "edges">;

/* -------------------------------- 边投影 ----------------------------------- */

export type EdgeArrowheads = { start: "arrow" | "none"; end: "arrow" | "none" };

/**
 * 箭头方向（§21）。
 *
 * 箭头表达「谁读谁」，与用户从哪一头拖出来无关：内容 → 终端单向指向终端；
 * 终端 ↔ 终端双向；内容 ↔ 内容无箭头，只表示归到一起。
 */
export function edgeArrowheads(
  sourceType?: string,
  targetType?: string,
): EdgeArrowheads {
  const sourceIsTerminal = sourceType === "terminal";
  const targetIsTerminal = targetType === "terminal";
  if (sourceIsTerminal && targetIsTerminal) {
    return { start: "arrow", end: "arrow" };
  }
  if (targetIsTerminal) return { start: "none", end: "arrow" };
  if (sourceIsTerminal) return { start: "arrow", end: "none" };
  return { start: "none", end: "none" };
}

/** 节点类型 → 连线标签的 i18n 键（§21 的那一行表）。 */
const EDGE_LABEL_KEYS: Record<string, string> = {
  sticky: "edge.sticky",
  editor: "edge.file",
  files: "edge.dir",
  browser: "edge.web",
  diff: "edge.diff",
};

/**
 * 连线中点的标签（i18n 键，不是文案）。
 *
 * 标签说的是「Agent 读到的是什么」：终端 ↔ 终端是互相读转录，写「上下文」；
 * 一端是内容节点时按那一端的类型写（便签 / 文件 / 目录 / 网页 / 差异）。
 *
 * 派发线（`role: "supervises"`）写「派发」（#318）：簇色与单向箭头说了方向，
 * 但一眼认出「这是派发、那是共享上下文」还得靠字。
 */
export function edgeLabelKey(
  sourceType?: string,
  targetType?: string,
  role?: CanvasEdgeRole,
): string {
  if (role === "supervises") return "edge.role.dispatch";
  const content =
    sourceType && sourceType !== "terminal"
      ? sourceType
      : targetType && targetType !== "terminal"
        ? targetType
        : null;
  if (!content) return "edge.context";
  return EDGE_LABEL_KEYS[content] ?? "edge.context";
}

function projectEdge(edge: CanvasEdge): ProjectedEdge {
  return {
    id: edge.id,
    type: "link",
    source: edge.source,
    target: edge.target,
    data: { ...(edge.role === undefined ? {} : { role: edge.role }) },
  };
}

function projectReference(reference: Reference, source: string): ProjectedEdge {
  return {
    id: reference.id,
    type: "reference",
    source,
    target: reference.nodeId,
  };
}

/**
 * 引用的来源端在画布上是哪个 id。
 *
 * `references.itemId` 存的是裸 uuid，两种来源共用这一格：白板对象在画布上
 * 是 `wb:<uuid>`，Frame 就是它自己的节点 id（`frame-reference.ts`）。都找不到
 * 就返回 null——那条引用指向已经删掉的东西，这一帧不画。
 */
function referenceSourceId(
  itemId: string,
  items: ReadonlySet<string>,
  frames: ReadonlySet<string>,
): string | null {
  const asItem = toItemId(itemId);
  if (items.has(asItem)) return asItem;
  return frames.has(itemId) ? itemId : null;
}

/** 两端有一个不在画布上的边投影不出来（远端刚删掉那个节点时会发生）。 */
export function projectEdges(
  document: CanvasTables | null,
  whiteboard: WhiteboardDoc,
): ProjectedEdge[] {
  const nodes = new Set((document?.nodes ?? []).map((node) => node.id));
  const frames = new Set(
    (document?.nodes ?? [])
      .filter((node) => node.type === "group")
      .map((node) => node.id),
  );
  const items = new Set(whiteboard.items.map((item) => toItemId(item.id)));
  const edges: ProjectedEdge[] = [];
  for (const edge of document?.edges ?? []) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    edges.push(projectEdge(edge));
  }
  for (const reference of whiteboard.references) {
    const source = referenceSourceId(reference.itemId, items, frames);
    if (!source) continue;
    if (!nodes.has(reference.nodeId)) continue;
    edges.push(projectReference(reference, source));
  }
  return edges;
}
