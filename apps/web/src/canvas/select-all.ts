import type { CanvasStore } from "@/store/canvas/types";
import { toItemId } from "./whiteboard/model";

/**
 * 全选（`canvas.selectAll`，⌘A / Ctrl+A，右键菜单同一条）。
 *
 * 选区只有一份真相，在画布 store 里：节点、边与白板对象各一张 id 表，
 * `setSelection` 一次写三项，React Flow 的 `selected` 是从它投影出来的。所以
 * 这里不碰 React Flow，只把三张表写满——之后拖动、删除、整理读的都是同一份
 * 选区，对多个节点一起生效。
 *
 * 白板对象在选区里带 `wb:` 前缀（`toItemId`）；引用边与连线共用「边」那一格。
 */
export function selectAllCanvas(
  state: Pick<CanvasStore, "document" | "whiteboard" | "setSelection">,
): void {
  state.setSelection({
    nodes: (state.document?.nodes ?? []).map((node) => node.id),
    items: state.whiteboard.items.map((item) => toItemId(item.id)),
    edges: [
      ...(state.document?.edges ?? []).map((edge) => edge.id),
      // 引用边与连线在选区里共用一格，全选自然也该把它们框进来。
      ...state.whiteboard.references.map((reference) => reference.id),
    ],
  });
}
