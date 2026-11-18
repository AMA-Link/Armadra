import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import { useBoard, useSelected } from "@armadra/board/react";

import { useCanvasStore } from "@/store/canvas-store";
import { useCanvasReadOnly } from "@/store/canvas/presence";
import { CardContent } from "../flow/nodes/CardContent";
import { GroupFrame } from "../flow/nodes/GroupFrame";
import { useNodeEntering } from "../flow/node-enter";
import { BoardHostProvider } from "./host-context";
import { GHOST_KIND, type BoardEntity } from "./model";

/**
 * 节点与分组的宿主内容（设计 §2.8）：位置与尺寸由引擎写宿主元素的 style，
 * 这里只管里面的 React 子树，复用现有的 `CardContent` / `GroupFrame`。
 */

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

/** 选中时的八个缩放把手；折叠的节点高度钉死，只留左右两条。 */
function ResizeHandles({ widthOnly = false }: { widthOnly?: boolean }) {
  if (useCanvasReadOnly()) return null;
  return HANDLES.filter((h) => !widthOnly || h === "e" || h === "w").map(
    (handle) => (
      <span
        key={handle}
        data-board-handle={handle}
        data-slot="board-resize-handle"
        className="board-resize-handle"
      />
    ),
  );
}

/**
 * 缩放把手只给「单选」的实体：多选时每个实体八个把手，框选三十个节点就是 240 个
 * 元素，取消选择时一起拆成垃圾，而多选里本来也没人去缩放其中一个。
 */
function useSoleSelected(id: string): boolean {
  const board = useBoard();
  const subscribe = React.useCallback(
    (notify: () => void) => board.on("selection", notify),
    [board],
  );
  const read = () => {
    const selection = board.selection();
    return selection.size === 1 && selection.has(id);
  };
  return React.useSyncExternalStore(subscribe, read, read);
}

/** 这个实体正在被手势预览（拖动 / 缩放中）；拖动中阴影加倍靠它。 */
function usePreviewing(id: string): boolean {
  const { scene } = useBoard();
  return React.useSyncExternalStore(
    React.useCallback(
      (notify) => scene.subscribe((ids) => ids.has(id) && notify()),
      [scene, id],
    ),
    () => scene.previewOf(id) !== undefined,
    () => false,
  );
}

export const CardHost = React.memo(function CardHost({
  entity,
}: {
  entity: BoardEntity;
}) {
  const node: CanvasNode = entity.data;
  const selected = useSelected(entity.id);
  const sole = useSoleSelected(entity.id);
  const ghost = entity.kind === GHOST_KIND;
  const dragging = usePreviewing(entity.id);
  const entering = useNodeEntering();
  const focused = useCanvasStore((state) => state.focusNodeId === entity.id);
  return (
    <BoardHostProvider value>
      {/* `contents`：只给样式一个挂 `data-dragging` 与 `data-entering` 的
          地方，不生成盒子。 */}
      <div
        data-slot="node-host"
        data-dragging={dragging ? "true" : undefined}
        data-entering={entering ? "true" : undefined}
        // ghost：`display:none` 让 `<webview>` 留在 DOM 里、页面不重载，只是看不见。
        style={ghost ? { display: "none" } : undefined}
        className="contents"
      >
        {sole && !ghost ? (
          <ResizeHandles widthOnly={node.collapsed === true} />
        ) : null}
        <CardContent node={node} selected={selected} focused={focused} />
      </div>
    </BoardHostProvider>
  );
});

export const GroupHost = React.memo(function GroupHost({
  entity,
}: {
  entity: BoardEntity;
}) {
  const selected = useSelected(entity.id);
  const sole = useSoleSelected(entity.id);
  return (
    <BoardHostProvider value>
      {sole ? <ResizeHandles /> : null}
      <GroupFrame node={entity.data} selected={selected} />
    </BoardHostProvider>
  );
});

export function renderEntity(entity: BoardEntity): React.ReactNode {
  return entity.kind === "group" ? (
    <GroupHost entity={entity} />
  ) : (
    <CardHost entity={entity} />
  );
}
