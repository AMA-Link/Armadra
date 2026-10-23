import * as React from "react";
import type { ConnectionLineComponentProps, Node } from "@xyflow/react";

import type { Box } from "../../geometry";
import { CORNER_RADIUS, routeFor, STROKE_WIDTH } from "./link-visual";
import { roundedPath } from "./route";

/**
 * 拖线时的预览（React Flow 计划 §2.5 第三条，归属 B1）。
 *
 * 和落成后的 `LinkEdge` 是**同一种线**：起点是起笔节点朝向指针那一侧的
 * 边中点，横平竖直、圆角拐弯（`link-visual.routeFor`，#318）。预览不绕障碍
 * ——指针每动一下都要画，松手后路由器再给出绕开节点的那一条。
 *
 * 指针还没落到任何节点上时，把指针本身当成一个零尺寸的矩形喂进去：
 * `facingSides` 于是按左右方向选边，和真的落上去时选的是同一侧。
 */

/** 落到合法目标上时预览线变成品牌色，否则维持中性灰。 */
const VALID_COLOR = "var(--brand)";
const NEUTRAL_COLOR = "var(--muted-foreground)";
const INVALID_COLOR = "var(--danger)";

function boxOf(node: {
  measured: { width?: number; height?: number };
  width?: number | null;
  height?: number | null;
  internals: { positionAbsolute: { x: number; y: number } };
}): Box {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  };
}

export function ConnectionLine({
  fromNode,
  toNode,
  toX,
  toY,
  connectionStatus,
}: ConnectionLineComponentProps<Node>) {
  const from = boxOf(fromNode);
  // 悬停在目标上时用目标的真实矩形，画的就是落成之后那条线。
  const to: Box = toNode
    ? boxOf(toNode)
    : { x: toX, y: toY, width: 0, height: 0 };
  const route = routeFor(from, to);
  const end = route.points[route.points.length - 1]!;
  const snapped = toNode !== undefined && toNode !== null;
  const invalid = connectionStatus === "invalid";
  const color =
    connectionStatus === "valid"
      ? VALID_COLOR
      : invalid
        ? INVALID_COLOR
        : NEUTRAL_COLOR;

  return (
    <g data-slot="connection-line">
      <path
        d={roundedPath(route.points, CORNER_RADIUS)}
        fill="none"
        stroke={color}
        style={{ strokeWidth: STROKE_WIDTH }}
        strokeLinecap="round"
        strokeLinejoin="round"
        // 还没落到目标上时用虚线：一眼能看出这条线还没连上东西。
        {...(toNode ? {} : { strokeDasharray: "6 4" })}
      />
      {/* 终点圆点：吸到目标上时软位移（canvas.css，只在 snapped 时过渡，免得拖线时
          圆点落后于指针）；目标不可连接时左右抖两次。 */}
      <circle
        data-snapped={snapped ? "true" : undefined}
        className={invalid ? "anim-shake" : undefined}
        style={{ cx: end.x, cy: end.y }}
        r={3}
        fill={color}
      />
    </g>
  );
}

export default React.memo(ConnectionLine);
