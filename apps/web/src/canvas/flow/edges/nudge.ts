import type { Position } from "@armadra/shared";

import type { Box, Side } from "../../geometry";
import { ROUTE_CLEARANCE } from "./route";

/**
 * 分道（纯函数，#318）：几条线走进同一道缝、在同一条网格线上重叠时，
 * 把它们的中间段往两侧错开 {@link LANE_GAP}，免得一条线盖住另一条。
 *
 * - 只动**中间段**：首段 / 末段连着节点的边中点，挪了就脱开了；
 * - 同一「束」（同一个主派出去的几条派发线）不错开——共用主干正是想要的；
 * - 错开后的线段仍要离障碍 {@link ROUTE_CLEARANCE} 以上，不行就换另一侧，
 *   两侧都不行就留在原地；
 * - 车道按优先级分：派发线留在中线，上下文线、引用线往外让。
 *
 * 正交折线挪一段只会让相邻两段变长或变短，仍然横平竖直。
 *
 * 在分道之前先**分端口**：几条不同束的线落在同一个节点的同一条边上时，
 * 沿这条边按来向排开 {@link PORT_GAP}，箭头不再叠在一个点上。
 */

export const LANE_GAP = 8;
export const PORT_GAP = 16;

export interface NudgeEnd {
  node: string;
  side: Side;
  box: Box;
}

export interface NudgeInput {
  id: string;
  bundle: string;
  /** 越小越靠中线。 */
  priority: number;
  points: readonly Position[];
  /** 这条线要避开的矩形（含两端）。 */
  obstacles: readonly Box[];
  source: NudgeEnd;
  target: NudgeEnd;
}

interface Segment {
  input: NudgeInput;
  /** 段的序号：points[k] → points[k + 1]。 */
  k: number;
  /** 段所在的线（横段是 y，竖段是 x）。 */
  at: number;
  lo: number;
  hi: number;
}

function clear(
  horizontal: boolean,
  at: number,
  lo: number,
  hi: number,
  obstacles: readonly Box[],
): boolean {
  return obstacles.every((box) => {
    const l = box.x - ROUTE_CLEARANCE;
    const r = box.x + box.width + ROUTE_CLEARANCE;
    const t = box.y - ROUTE_CLEARANCE;
    const b = box.y + box.height + ROUTE_CLEARANCE;
    return horizontal
      ? !(at > t && at < b && lo < r && hi > l)
      : !(at > l && at < r && lo < b && hi > t);
  });
}

/** 返回错开后的折线；没被挪的线不在结果里。 */
export function nudge(inputs: readonly NudgeInput[]): Map<string, Position[]> {
  const result = new Map<string, Position[]>();
  const pointsOf = (input: NudgeInput): Position[] => {
    let points = result.get(input.id);
    if (!points) {
      points = input.points.map((point) => ({ ...point }));
      result.set(input.id, points);
    }
    return points;
  };

  spreadPorts(inputs, pointsOf, result);

  for (const horizontal of [true, false]) {
    const lines = new Map<number, Segment[]>();
    for (const input of inputs) {
      const points = result.get(input.id) ?? input.points;
      for (let k = 1; k < points.length - 2; k += 1) {
        const a = points[k]!;
        const b = points[k + 1]!;
        if (horizontal ? a.y !== b.y : a.x !== b.x) continue;
        const at = horizontal ? a.y : a.x;
        const lo = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
        const hi = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
        const list = lines.get(at) ?? [];
        list.push({ input, k, at, lo, hi });
        lines.set(at, list);
      }
    }

    for (const segments of lines.values()) {
      if (segments.length < 2) continue;
      segments.sort((a, b) => a.lo - b.lo);
      // 沿线把互相重叠的段并成簇。
      let cluster: Segment[] = [];
      let reach = -Infinity;
      const flush = () => {
        if (cluster.length > 1) spread(cluster, horizontal);
        cluster = [];
      };
      for (const segment of segments) {
        if (segment.lo >= reach - 1) flush();
        cluster.push(segment);
        reach = Math.max(reach, segment.hi);
      }
      flush();
    }
  }

  function spread(cluster: Segment[], horizontal: boolean): void {
    const bundles = new Map<string, Segment[]>();
    for (const segment of cluster) {
      const list = bundles.get(segment.input.bundle) ?? [];
      list.push(segment);
      bundles.set(segment.input.bundle, list);
    }
    if (bundles.size < 2) return;
    const ordered = [...bundles.entries()].sort(([a, sa], [b, sb]) => {
      const pa = Math.min(...sa.map((s) => s.input.priority));
      const pb = Math.min(...sb.map((s) => s.input.priority));
      return pa === pb ? (a < b ? -1 : a > b ? 1 : 0) : pa - pb;
    });
    const used = new Set<number>([0]);
    ordered.forEach(([, members], index) => {
      if (index === 0) return;
      // 车道 +1, -1, +2, -2 …，取第一条对这一束里每一段都放得下的。
      for (let step = 1; step <= 4; step += 1) {
        for (const sign of [1, -1]) {
          const offset = sign * step * LANE_GAP;
          if (used.has(offset)) continue;
          const fits = members.every((segment) =>
            clear(
              horizontal,
              segment.at + offset,
              segment.lo,
              segment.hi,
              segment.input.obstacles,
            ),
          );
          if (!fits) continue;
          used.add(offset);
          for (const segment of members) {
            const points = pointsOf(segment.input);
            for (const j of [segment.k, segment.k + 1]) {
              if (horizontal) points[j]!.y = segment.at + offset;
              else points[j]!.x = segment.at + offset;
            }
          }
          return;
        }
      }
    });
  }

  return result;
}

/** 沿边的那条轴：上下边沿 x 排，左右边沿 y 排。 */
function alongX(side: Side): boolean {
  return side === "top" || side === "bottom";
}

function spreadPorts(
  inputs: readonly NudgeInput[],
  pointsOf: (input: NudgeInput) => Position[],
  result: Map<string, Position[]>,
): void {
  interface Port {
    input: NudgeInput;
    end: "source" | "target";
  }
  const groups = new Map<string, Port[]>();
  for (const input of inputs) {
    for (const end of ["source", "target"] as const) {
      const info = input[end];
      const key = `${info.node}|${info.side}`;
      const list = groups.get(key) ?? [];
      list.push({ input, end });
      groups.set(key, list);
    }
  }

  for (const ports of groups.values()) {
    const bundles = new Map<string, Port[]>();
    for (const port of ports) {
      const list = bundles.get(port.input.bundle) ?? [];
      list.push(port);
      bundles.set(port.input.bundle, list);
    }
    if (bundles.size < 2) continue;
    const { side, box } = ports[0]!.input[ports[0]!.end];
    const byX = alongX(side);
    // 来向：离这条边最远的那个拐点在边方向上的坐标。
    const approach = (port: Port): number => {
      const points = result.get(port.input.id) ?? port.input.points;
      const far =
        port.end === "source"
          ? points[Math.min(2, points.length - 1)]!
          : points[Math.max(0, points.length - 3)]!;
      return byX ? far.x : far.y;
    };
    const ordered = [...bundles.values()].sort(
      (a, b) =>
        Math.min(...a.map(approach)) - Math.min(...b.map(approach)) ||
        (a[0]!.input.id < b[0]!.input.id ? -1 : 1),
    );
    const length = byX ? box.width : box.height;
    const limit = length / 2 - 12;
    const count = ordered.length;
    const gap = Math.min(PORT_GAP, limit > 0 ? (limit * 2) / (count - 1) : 0);
    if (gap < 4) continue;
    ordered.forEach((members, index) => {
      const offset = (index - (count - 1) / 2) * gap;
      if (offset === 0) return;
      for (const port of members) shiftPort(port.input, port.end, offset);
    });
  }

  function shiftPort(
    input: NudgeInput,
    end: "source" | "target",
    offset: number,
  ): void {
    const current = result.get(input.id) ?? input.points;
    const m = current.length;
    const byX = alongX(input[end].side);
    // 两点一线：两端一起挪，另一端也得还在自己那条边上。
    const indices =
      m === 2 ? [0, 1] : end === "source" ? [0, 1] : [m - 1, m - 2];
    if (m === 2) {
      const other = input[end === "source" ? "target" : "source"];
      if (alongX(other.side) !== byX) return;
      const at = (byX ? current[0]!.x : current[0]!.y) + offset;
      const lo = byX ? other.box.x : other.box.y;
      const hi = lo + (byX ? other.box.width : other.box.height);
      if (at < lo + 12 || at > hi - 12) return;
    }
    const a = current[indices[0]!]!;
    const b = current[indices[1]!]!;
    const moved = byX ? a.x + offset : a.y + offset;
    const lo = byX ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    const hi = byX ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
    const own = input[end].box;
    const others = input.obstacles.filter(
      (box) =>
        box !== own &&
        box !== input[end === "source" ? "target" : "source"].box,
    );
    if (!clear(!byX, moved, lo, hi, others)) return;
    const points = pointsOf(input);
    for (const index of indices) {
      if (byX) points[index]!.x += offset;
      else points[index]!.y += offset;
    }
  }
}
