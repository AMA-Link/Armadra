import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";
import { BoardView, EntityHosts } from "@armadra/board/react";

import { useResolvedTheme } from "@/app/preferences-store";
import { BoardEdges } from "@/canvas/board/BoardEdges";
import { MinimapView } from "@/canvas/board/BoardMinimap";
import { edgeEntity, edgeKinds } from "@/canvas/board/edge-model";
import { GroupHost } from "@/canvas/board/hosts";
import {
  BOARD_SELECTORS,
  entityOf,
  nodeKinds,
  type BoardEntity,
} from "@/canvas/board/model";
import { boardColor } from "@/canvas/board/whiteboard/paint-env";
import {
  minimapToggleStyle,
  MinimapToggleButton,
} from "@/canvas/flow/minimap-style";
import type { ProjectedEdge } from "@/canvas/sync/project-edges";

/**
 * 展示页的静态画布：用真的画板引擎（场景、世界层宿主、连线层、缩略图）画一份
 * 固定的节点与连线，不接应用状态、不响应手势。节点内容由调用方给（展示页用静态
 * 内容代替真终端与真编辑器）；分组与连线是画布上的真组件。
 */

type StaticMinimap = "expanded" | "collapsed" | "none";

export interface StaticBoardProps {
  nodes: readonly CanvasNode[];
  edges?: readonly ProjectedEdge[];
  /** 一个非分组节点的内容。 */
  renderNode: (node: CanvasNode) => React.ReactNode;
  /** 缩略图：展开（右上角「−」定格在悬停时）、收起（只有展开钮）或没有。 */
  minimap?: StaticMinimap;
}

const noop = () => {};

export function StaticBoard({
  nodes,
  edges = [],
  renderNode,
  minimap = "none",
}: StaticBoardProps) {
  const theme = useResolvedTheme();
  const board = React.useMemo(() => {
    const created = createBoard<CanvasNode>({
      kinds: { ...nodeKinds(), ...edgeKinds() },
      color: boardColor,
      selectors: BOARD_SELECTORS,
      camera: { x: 0, y: 0, zoom: 1 },
      readOnly: true,
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    created.scene.transact(
      (draft) => {
        for (const node of nodes) draft.set(entityOf(node, byId));
        for (const edge of edges) draft.set(edgeEntity(edge));
      },
      { history: "ignore" },
    );
    created.camera.locked = true;
    return created;
    // 展示页的内容是模块级常量，只在挂载时造一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    board.setOptions({ theme });
  }, [board, theme]);

  const render = React.useCallback(
    (entity: BoardEntity) =>
      entity.kind === "group" ? (
        <GroupHost entity={entity} />
      ) : (
        <div data-slot="node-host" className="contents">
          {renderNode(entity.data)}
        </div>
      ),
    [renderNode],
  );

  return (
    <>
      <BoardView board={board} className="absolute inset-0">
        <EntityHosts<CanvasNode> render={render} />
        <BoardEdges />
      </BoardView>
      {minimap === "expanded" ? <MinimapView board={board} /> : null}
      {minimap === "none" ? null : (
        <div
          className="minimap-toggle-panel"
          style={minimapToggleStyle(minimap === "collapsed")}
        >
          <MinimapToggleButton
            collapsed={minimap === "collapsed"}
            onToggle={noop}
            reveal={minimap === "expanded"}
          />
        </div>
      )}
    </>
  );
}
