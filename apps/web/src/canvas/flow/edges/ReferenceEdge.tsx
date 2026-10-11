import * as React from "react";
import { BaseEdge, EdgeLabelRenderer } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { removeContentReference } from "../../create-content-reference";
import type { ReferenceFlowEdge } from "../../sync/project";
import { EdgeLabel, useEdgeLayout } from "./EdgeLabel";
import { arrowHead, INTERACTION_WIDTH, STROKE_WIDTH } from "./link-visual";
import { midpointOf } from "./route";

/**
 * 内容引用边（React Flow 计划 §2.3 / F29，归属 B5）。
 *
 * 与 `LinkEdge` 的三点不同，都是为了让它一眼就不像一条上下文连线：
 *
 *  - **虚线**。引用是「这块内容归那个 Agent 读」的记账，不是两个节点之间的
 *    关系，画得越轻越好；路线与上下文线同一套避障折线（#318），标签「引用」。
 *  - **单箭头指向节点**（`source` 永远是 `wb:*`，`target` 永远是节点，
 *    `sync/project.projectReference` 定的），方向就是资料流向。
 *  - **静音配色** `--muted-foreground`。
 *
 * 端点用两端矩形边中点（四条边都可以出线），不是把手坐标：白板对象上根本
 * 没有左右把手，而一条从下方墨迹指上来的引用应该从墨迹的上边出发。
 *
 * 选中时在中点浮一个删除按钮。引用边的 id 不在 `document.edges` 里，
 * `tools.splitSelectionForDelete`（B0）因此认不出它，Delete 键当前删不掉
 * 一条引用——按钮是这一版里唯一不依赖右键菜单的出口（见交接记录）。
 */

export function ReferenceEdge({
  id,
  selected = false,
  style,
}: EdgeProps<ReferenceFlowEdge>) {
  const t = useT();
  // 与上下文线同一套避障路由（#318），只是画成虚线。
  const layout = useEdgeLayout(id);
  if (!layout) return null;

  const { route } = layout.view;
  const { text: label, label: labelBox } = layout;
  const points = route.points;
  const to = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const middle = midpointOf(points);
  const width = selected ? STROKE_WIDTH : STROKE_WIDTH - 0.5;
  const color = selected ? "var(--brand)" : "var(--muted-foreground)";

  return (
    <g style={{ color }} data-slot="reference-edge">
      <BaseEdge
        path={layout.view.d}
        interactionWidth={INTERACTION_WIDTH}
        style={{
          ...style,
          stroke: "currentColor",
          strokeWidth: width,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          // 虚线：与实线的上下文连线一眼分得开，深浅色下都成立。
          strokeDasharray: "6 5",
          opacity: selected ? 1 : 0.75,
        }}
      />
      <path
        d={arrowHead(to, before)}
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={selected ? 1 : 0.75}
      />
      {labelBox && !selected ? <EdgeLabel box={labelBox} text={label} /> : null}
      {selected ? (
        <EdgeLabelRenderer>
          <Button
            variant="secondary"
            size="icon-xs"
            aria-label={t("shape.removeReference")}
            title={t("shape.removeReference")}
            data-slot="reference-remove"
            className="nodrag nopan pointer-events-auto absolute shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${
                labelBox?.x ?? middle.x
              }px, ${labelBox?.y ?? middle.y}px)`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              removeContentReference(id);
            }}
          >
            <X />
          </Button>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

export default React.memo(ReferenceEdge);
