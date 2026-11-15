import type { ForgeRepoRef } from "@armadra/shared";

import { nodeDropPosition } from "@/canvas/placement";
import { revealCreatedNode } from "@/canvas/created-node";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 「加到画板」：把一条 Issue / PR 放成画布上的卡片（#934）。节点只记仓库坐标、
 * 种类与编号；标题写成 `仓库名#编号`，不带远端的标题与正文。没有打开的画板时
 * 什么都不做、答空串。
 */
export function addForgeItemToCanvas(
  repo: ForgeRepoRef,
  itemKind: "issue" | "pull",
  number: number,
): string {
  const id = useCanvasStore.getState().addNode("forgeItem", {
    position: nodeDropPosition("forgeItem"),
    title: `${repo.name}#${number}`,
    data: {
      kind: "forgeItem",
      repo: { host: repo.host, owner: repo.owner, name: repo.name },
      itemKind,
      number,
    },
  });
  if (id) revealCreatedNode(id);
  return id;
}

/** 当前有没有能放卡片的画板。 */
export function useCanAddToCanvas(): boolean {
  return useCanvasStore((state) => state.document !== null);
}
