import type { Box } from "../../geometry";
import { roundedPath, routeFor } from "@armadra/board/core";
import { CORNER_RADIUS, STROKE_WIDTH } from "./link-visual";

/**
 * 拖线时的预览。
 *
 * 和落成后的连线是**同一种线**：起点是起笔节点朝向指针那一侧的
 * 边中点，横平竖直、圆角拐弯（`core/route 的 routeFor`，#318）。预览不绕障碍
 * ——指针每动一下都要画，松手后路由器再给出绕开节点的那一条。
 *
 * 指针还没落到任何节点上时，把指针本身当成一个零尺寸的矩形喂进去：
 * `facingSides` 于是按左右方向选边，和真的落上去时选的是同一侧。
 */

/** 落到合法目标上时预览线变成品牌色，否则维持中性灰。 */
const VALID_COLOR = "var(--brand)";
const NEUTRAL_COLOR = "var(--muted-foreground)";
const INVALID_COLOR = "var(--danger)";

export type ConnectionStatus = "valid" | "invalid" | null | undefined;

/**
 * 预览线本体：两端矩形与状态 → 一条圆角折线加终点圆点
 * （`board/connect-preview.tsx` 喂两端的矩形）。
 */
export function ConnectionPath({
  from,
  to,
  snapped,
  status,
}: {
  from: Box;
  to: Box;
  snapped: boolean;
  status: ConnectionStatus;
}) {
  const route = routeFor(from, to);
  const end = route.points[route.points.length - 1]!;
  const invalid = status === "invalid";
  const color =
    status === "valid" ? VALID_COLOR : invalid ? INVALID_COLOR : NEUTRAL_COLOR;

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
        {...(snapped ? {} : { strokeDasharray: "6 4" })}
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
