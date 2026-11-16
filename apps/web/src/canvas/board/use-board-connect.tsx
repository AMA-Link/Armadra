import * as React from "react";
import type { CanvasNode, CanvasNodeType } from "@armadra/shared";
import type { DomBoard } from "@armadra/board/dom";

import { nodeMeta } from "@/nodes/registry";
import {
  commitConnection,
  rejectConnection,
} from "../flow/edges/connect-commit";
import { useConnectEndSpawn } from "../flow/use-connect-end";
import { installConnectFeedback } from "./connect-preview";
import { GROUP_KIND, nodeKinds } from "./model";

/**
 * 连线手势的落点（B4）：引擎的 `connect` 事件 → 现有的建边逻辑。
 *
 *  - 落在节点（或白板对象）上：按判定表建一条边 / 一条内容引用，被拒绝时提示
 *    一次（与旧引擎的 `onConnect` + `onConnectEnd` 同一份动作，`connect-commit.ts`）；
 *  - 落在空白处：从 Agent 终端起笔的，在落点开「派发」菜单（`use-connect-end.tsx`）；
 *    其余是取消，什么都不发生。
 *
 * 起笔资格登记在种类表上：只有带桥接把手的节点能起笔（`hasBridgeHandles`），
 * 分组与白板对象只作落点。
 */

/** 在种类表上补上连线资格；只覆盖 `connect`，其余沿用 `nodeKinds()` 的登记。 */
export function registerConnectKinds(board: DomBoard<CanvasNode>): void {
  for (const [kind, spec] of Object.entries(nodeKinds())) {
    const type = kind.split(":")[0] as CanvasNodeType;
    const start = kind === GROUP_KIND ? false : nodeMeta(type).hasBridgeHandles;
    board.registerKind(kind, { ...spec, connect: { start, end: true } });
  }
}

export function useBoardConnect(
  board: DomBoard<CanvasNode>,
  stage: React.RefObject<HTMLElement | null>,
): React.ReactNode {
  const { onConnectEnd, menu } = useConnectEndSpawn();

  React.useEffect(() => {
    registerConnectKinds(board);
    const restore = installConnectFeedback(board);
    const stop = board.on("connect", ({ from, to, at }) => {
      if (to !== null) {
        if (!commitConnection(from, to)) rejectConnection(from, to);
        return;
      }
      // 落回起笔的节点自己身上：引擎把起笔节点排除在落点之外（得到空白），
      // 旧画布则当作自连提示一次，这里补上同一句提示，不开派发菜单。
      const onSelf = board.scene
        .query({ x: at.x, y: at.y, w: 0, h: 0 })
        .some((entity) => entity.id === from);
      if (onSelf) {
        rejectConnection(from, from);
        return;
      }
      // 派发菜单要松手处的屏幕坐标：世界坐标 → 舞台内 → 视口。
      const rect = stage.current?.getBoundingClientRect();
      const screen = board.camera.worldToScreen(at);
      const client = {
        clientX: screen.x + (rect?.left ?? 0),
        clientY: screen.y + (rect?.top ?? 0),
      };
      onConnectEnd(
        client as MouseEvent,
        {
          isValid: false,
          toNode: null,
          fromNode: { id: from },
        } as never,
      );
    });
    return () => {
      stop();
      restore();
    };
  }, [board, onConnectEnd, stage]);

  return menu;
}
