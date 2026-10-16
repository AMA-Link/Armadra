import type { Position } from "@armadra/shared";

import { anchorPoint, type Box, type Side } from "../../geometry";
import { SOFT_RADIUS, softPath } from "./smooth";

/**
 * 连线的避障正交路由（纯函数，#318）。
 *
 * 两端从边中点**垂直**出线，中间只走横竖线段，绕开附近节点的矩形：
 *
 *  1. 稀疏网格：每个障碍（含两端自己）左右上下各外扩 {@link ROUTE_PADDING}
 *     的那几条线、相邻矩形边之间的中线、两端锚点所在的线、再加一圈外框，
 *     横竖交叉出网格点；落在障碍里（外扩 {@link ROUTE_CLEARANCE}）的点不要；
 *  2. 在网格上跑带拐弯代价的最短路（状态 = 网格点 × 到达方向），拐一次弯
 *     记 {@link BEND_COST}，不许掉头；
 *  3. 允许的出线边 / 入线边由调用方给（派发线按布局方向只给一条），非首选
 *     的边与「上一次不是这条边」各加一点代价——后者是拖动时的防抖黏性。
 *
 * 外框在所有障碍之外，所以总有一条路；真找不到（两端叠在一起）时退回一条
 * 不看障碍的 Z 形折线。
 */

/** 网格线离障碍的距离：线贴着节点走时离它这么远。 */
export const ROUTE_PADDING = 20;
/** 硬间距：线段不许进入障碍外扩这么多的范围。 */
export const ROUTE_CLEARANCE = 6;
/**
 * 期望的最小净距：线段离节点不到这么远就算「贴着走」，这一段的长度按
 * 1 + {@link NARROW_BASE} + 差额比例 × {@link NARROW_COST} 倍计。缝宽不够两倍
 * 净距时，穿缝因此比从外侧绕一圈更贵；绕不开（派发线从两排之间出发）时仍然
 * 穿缝，并且走正中间。
 */
export const ROUTE_MIN_CLEARANCE = 16;
/**
 * 横线从节点**上沿**（标题栏所在的那条边）上方经过时要求的净距：标题栏上有
 * 文字和按钮，线贴着它走比贴着别的边更碍眼。窄缝里放不下时仍然走正中间。
 */
export const ROUTE_TITLE_CLEARANCE = 20;
/** 只要贴着走就先罚这么多倍；再按差多少净距加罚，最多再加 {@link NARROW_COST}。 */
export const NARROW_BASE = 3;
export const NARROW_COST = 4;
/** 拐一次弯折合多少长度。 */
export const BEND_COST = 40;
/**
 * 走非首选的边多付的代价。故意比 {@link STICKY_COST} 小：首选边只在两条路线
 * 几乎一样长时打破平手，而拖到「首选边刚好翻转」的那条分界线上时，上一次
 * 的边还能再黏一会儿，线不会来回跳。
 */
const SIDE_COST = 12;
/** 上一次不是这条边多付的代价（防抖黏性）。 */
const STICKY_COST = 24;
/** 外框离所有矩形的距离。 */
const FRAME_MARGIN = ROUTE_PADDING * 2;

export interface SidePair {
  source: Side;
  target: Side;
}

export interface RouteRequest {
  source: Box;
  target: Box;
  /** 两端之外的障碍矩形（调用方已按区域筛过）。 */
  obstacles: readonly Box[];
  sourceSides: readonly Side[];
  targetSides: readonly Side[];
  /** 首选的一对边；不在其中的边多付 {@link SIDE_COST}。 */
  preferred?: SidePair | undefined;
  /** 上一次走的边；换边多付 {@link STICKY_COST}。 */
  previous?: SidePair | undefined;
}

export interface Route {
  /** 折线顶点（画布坐标），首尾是两端的锚点，已去掉共线的中间点。 */
  points: Position[];
  sourceSide: Side;
  targetSide: Side;
}

/** 0 右 1 下 2 左 3 上。 */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function outward(side: Side): number {
  switch (side) {
    case "right":
      return 0;
    case "bottom":
      return 1;
    case "left":
      return 2;
    case "top":
      return 3;
  }
}

/** 取到半个单位：拖动时亚像素的抖动不进几何。 */
function snap(value: number): number {
  return Math.round(value * 2) / 2;
}

function sortedUnique(values: number[]): number[] {
  const sorted = values.map(snap).sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    if (out.length === 0 || value !== out[out.length - 1]) out.push(value);
  }
  return out;
}

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

function inflate(box: Box, by: number): Rect {
  return {
    l: box.x - by,
    t: box.y - by,
    r: box.x + box.width + by,
    b: box.y + box.height + by,
  };
}

/** 横竖线段是否穿进矩形内部（贴边不算）。 */
function segmentHits(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: Rect,
): boolean {
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  if (minY === maxY) {
    return minY > rect.t && minY < rect.b && minX < rect.r && maxX > rect.l;
  }
  return minX > rect.l && minX < rect.r && minY < rect.b && maxY > rect.t;
}

/** 二叉小顶堆（代价, 状态）。 */
class Heap {
  private costs: number[] = [];
  private states: number[] = [];

  get size(): number {
    return this.costs.length;
  }

  push(cost: number, state: number): void {
    const { costs, states } = this;
    let i = costs.length;
    costs.push(cost);
    states.push(state);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (costs[parent]! <= cost) break;
      costs[i] = costs[parent]!;
      states[i] = states[parent]!;
      i = parent;
    }
    costs[i] = cost;
    states[i] = state;
  }

  pop(): [number, number] {
    const { costs, states } = this;
    const top: [number, number] = [costs[0]!, states[0]!];
    const lastCost = costs.pop()!;
    const lastState = states.pop()!;
    const n = costs.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= n) break;
        const right = left + 1;
        const child = right < n && costs[right]! < costs[left]! ? right : left;
        if (costs[child]! >= lastCost) break;
        costs[i] = costs[child]!;
        states[i] = states[child]!;
        i = child;
      }
      costs[i] = lastCost;
      states[i] = lastState;
    }
    return top;
  }
}

/** 去掉共线的中间点与重复点。 */
export function simplify(points: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    if (out.length >= 2) {
      const prev = out[out.length - 2]!;
      const collinear =
        (prev.x === last!.x && last!.x === point.x) ||
        (prev.y === last!.y && last!.y === point.y);
      if (collinear) {
        out[out.length - 1] = point;
        continue;
      }
    }
    out.push(point);
  }
  return out;
}

/** 找不到路时的退路：两端之间一条不看障碍的 Z 形折线。 */
function fallback(request: RouteRequest): Route {
  const sourceSide = request.preferred?.source ?? request.sourceSides[0]!;
  const targetSide = request.preferred?.target ?? request.targetSides[0]!;
  const from = anchorPoint(request.source, sourceSide);
  const to = anchorPoint(request.target, targetSide);
  const start = { x: snap(from.x), y: snap(from.y) };
  const end = { x: snap(to.x), y: snap(to.y) };
  const vertical = sourceSide === "top" || sourceSide === "bottom";
  const mid = vertical
    ? [
        { x: start.x, y: snap((start.y + end.y) / 2) },
        { x: end.x, y: snap((start.y + end.y) / 2) },
      ]
    : [
        { x: snap((start.x + end.x) / 2), y: start.y },
        { x: snap((start.x + end.x) / 2), y: end.y },
      ];
  return { points: simplify([start, ...mid, end]), sourceSide, targetSide };
}

function sideCost(
  side: Side,
  preferred: Side | undefined,
  previous: Side | undefined,
): number {
  let cost = 0;
  if (preferred !== undefined && side !== preferred) cost += SIDE_COST;
  if (previous !== undefined && side !== previous) cost += STICKY_COST;
  return cost;
}

/**
 * 两端之间的一条正交路线。
 *
 * 复杂度：网格是 O(n) × O(n)（n = 附近的矩形数），每个状态扩展时对 n 个
 * 矩形做线段检测；调用方只给附近的障碍，十几个矩形时一次在亚毫秒级。
 */
export function routeEdge(request: RouteRequest): Route {
  const { source, target } = request;
  const all: Box[] = [source, target, ...request.obstacles];
  const hard = all.map((box) => inflate(box, ROUTE_CLEARANCE));

  // —— 网格线 ——
  const xs: number[] = [];
  const ys: number[] = [];
  const edgesX: number[] = [];
  const edgesY: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /**
   * 一条外扩线是否落进了另一个矩形的外扩带：两个矩形之间的缝不到两倍外扩时，
   * 贴着一边走会离另一边太近（也挤掉了标签的位置），只留中线。
   */
  const crowded = (value: number, axis: "x" | "y", owner: Box): boolean =>
    all.some((other) => {
      if (other === owner) return false;
      const lo = axis === "x" ? other.x : other.y;
      const hi = lo + (axis === "x" ? other.width : other.height);
      if (value <= lo - ROUTE_PADDING || value >= hi + ROUTE_PADDING) {
        return false;
      }
      // 另一条轴上要挨得着，否则这条线根本不从它旁边过。
      const a0 = axis === "x" ? owner.y : owner.x;
      const a1 = a0 + (axis === "x" ? owner.height : owner.width);
      const b0 = axis === "x" ? other.y : other.x;
      const b1 = b0 + (axis === "x" ? other.height : other.width);
      return a0 - ROUTE_PADDING < b1 && a1 + ROUTE_PADDING > b0;
    });
  for (const box of all) {
    const r = box.x + box.width;
    const b = box.y + box.height;
    for (const x of [box.x - ROUTE_PADDING, r + ROUTE_PADDING]) {
      if (!crowded(x, "x", box)) xs.push(x);
    }
    for (const y of [box.y - ROUTE_PADDING, b + ROUTE_PADDING]) {
      if (!crowded(y, "y", box)) ys.push(y);
    }
    edgesX.push(box.x, r);
    edgesY.push(box.y, b);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, r);
    maxY = Math.max(maxY, b);
  }
  // 相邻矩形边之间的中线：窄缝里走正中间。
  const sortedX = sortedUnique(edgesX);
  for (let i = 1; i < sortedX.length; i += 1) {
    xs.push((sortedX[i - 1]! + sortedX[i]!) / 2);
  }
  const sortedY = sortedUnique(edgesY);
  for (let i = 1; i < sortedY.length; i += 1) {
    ys.push((sortedY[i - 1]! + sortedY[i]!) / 2);
  }
  xs.push(minX - FRAME_MARGIN, maxX + FRAME_MARGIN);
  ys.push(minY - FRAME_MARGIN, maxY + FRAME_MARGIN);

  interface Anchor {
    side: Side;
    point: Position;
    dir: number;
    cost: number;
  }
  const anchors = (
    box: Box,
    sides: readonly Side[],
    preferred: Side | undefined,
    previous: Side | undefined,
  ): Anchor[] =>
    sides.map((side) => {
      const raw = anchorPoint(box, side);
      const point = { x: snap(raw.x), y: snap(raw.y) };
      xs.push(point.x);
      ys.push(point.y);
      return {
        side,
        point,
        dir: outward(side),
        cost: sideCost(side, preferred, previous),
      };
    });
  const starts = anchors(
    source,
    request.sourceSides,
    request.preferred?.source,
    request.previous?.source,
  );
  const ends = anchors(
    target,
    request.targetSides,
    request.preferred?.target,
    request.previous?.target,
  );

  const gx = sortedUnique(xs);
  const gy = sortedUnique(ys);
  const nx = gx.length;
  const ny = gy.length;
  const count = nx * ny;
  const indexX = new Map(gx.map((value, i) => [value, i]));
  const indexY = new Map(gy.map((value, i) => [value, i]));

  // —— 网格点是否可用 ——
  const free = new Uint8Array(count);
  for (let j = 0; j < ny; j += 1) {
    const y = gy[j]!;
    for (let i = 0; i < nx; i += 1) {
      const x = gx[i]!;
      let ok = 1;
      for (const rect of hard) {
        if (x > rect.l && x < rect.r && y > rect.t && y < rect.b) {
          ok = 0;
          break;
        }
      }
      free[j * nx + i] = ok;
    }
  }

  const blocked = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    skip: number,
  ): boolean => {
    for (let k = 0; k < hard.length; k += 1) {
      if (k === skip) continue;
      if (segmentHits(ax, ay, bx, by, hard[k]!)) return true;
    }
    return false;
  };

  /** 锚点沿出线方向走到的第一个可用网格点（跳过自己外扩区里的点）。 */
  const firstFree = (anchor: Anchor, own: number): number => {
    let i = indexX.get(anchor.point.x)!;
    let j = indexY.get(anchor.point.y)!;
    for (;;) {
      i += DX[anchor.dir]!;
      j += DY[anchor.dir]!;
      if (i < 0 || j < 0 || i >= nx || j >= ny) return -1;
      const node = j * nx + i;
      if (!free[node]) continue;
      return blocked(anchor.point.x, anchor.point.y, gx[i]!, gy[j]!, own)
        ? -1
        : node;
    }
  };

  // —— 最短路：状态 = 网格点 * 4 + 到达方向；终点锚各一个状态，再加一个汇点 ——
  const endBase = count * 4;
  const sink = endBase + ends.length;
  const total = sink + 1;
  const dist = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const startOf = new Int32Array(total).fill(-1);
  const heap = new Heap();

  const entries = new Map<number, number[]>();
  ends.forEach((anchor, k) => {
    const node = firstFree(anchor, 1);
    if (node < 0) return;
    const list = entries.get(node) ?? [];
    list.push(k);
    entries.set(node, list);
  });

  starts.forEach((anchor, k) => {
    const node = firstFree(anchor, 0);
    if (node < 0) return;
    const state = node * 4 + anchor.dir;
    const cost =
      anchor.cost +
      Math.abs(gx[node % nx]! - anchor.point.x) +
      Math.abs(gy[Math.floor(node / nx)]! - anchor.point.y);
    if (cost < dist[state]!) {
      dist[state] = cost;
      parent[state] = -1;
      startOf[state] = k;
      heap.push(cost, state);
    }
  });

  /**
   * 贴着节点走的代价倍数（0 = 不贴）：差多少净距罚多少，所以窄缝里走正中间
   * 比贴着一边便宜。两端自己只算「顺着它的边走」的那种贴法——垂直进出它的
   * 线段本来就挨着它。
   */
  const narrow = (ax: number, ay: number, bx: number, by: number): number => {
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    const horizontal = minY === maxY;
    let worst = 0;
    for (let k = 0; k < all.length; k += 1) {
      const box = all[k]!;
      const dx = Math.max(0, box.x - maxX, minX - (box.x + box.width));
      const dy = Math.max(0, box.y - maxY, minY - (box.y + box.height));
      if (k < 2 && (horizontal ? dx > 0 : dy > 0)) continue;
      // 横线在这个节点上沿的正上方：按标题栏的净距要求。
      const overTitle = horizontal && dx === 0 && box.y >= maxY;
      const want = overTitle ? ROUTE_TITLE_CLEARANCE : ROUTE_MIN_CLEARANCE;
      const deficit = (want - Math.hypot(dx, dy)) / want;
      if (deficit > worst) worst = deficit;
    }
    return worst > 0 ? NARROW_BASE + worst * NARROW_COST : 0;
  };

  // 网格边是否可走：0 未测，1 可走，2 被挡；可走时另记贴边罚的倍数。
  const rightOpen = new Uint8Array(count);
  const downOpen = new Uint8Array(count);
  const rightPenalty = new Float32Array(count);
  const downPenalty = new Float32Array(count);

  const relax = (from: number, to: number, cost: number): void => {
    if (cost < dist[to]!) {
      dist[to] = cost;
      parent[to] = from;
      heap.push(cost, to);
    }
  };

  let found = false;
  while (heap.size > 0) {
    const [cost, state] = heap.pop();
    if (cost > dist[state]!) continue;
    if (state === sink) {
      found = true;
      break;
    }
    if (state >= endBase) {
      const k = state - endBase;
      relax(state, sink, cost + ends[k]!.cost);
      continue;
    }
    const node = state >> 2;
    const arrived = state & 3;
    const i = node % nx;
    const j = (node - i) / nx;
    const x = gx[i]!;
    const y = gy[j]!;

    // 进终点锚：只许沿入线方向（出线方向的反方向）进去。
    const targets = entries.get(node);
    if (targets) {
      for (const k of targets) {
        const anchor = ends[k]!;
        const inward = (anchor.dir + 2) & 3;
        const bend = inward === arrived ? 0 : BEND_COST;
        if (((arrived + 2) & 3) === inward) continue;
        relax(
          state,
          endBase + k,
          cost +
            bend +
            Math.abs(anchor.point.x - x) +
            Math.abs(anchor.point.y - y),
        );
      }
    }

    for (let dir = 0; dir < 4; dir += 1) {
      if (dir === ((arrived + 2) & 3)) continue;
      const ni = i + DX[dir]!;
      const nj = j + DY[dir]!;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const next = nj * nx + ni;
      if (!free[next]) continue;
      const tx = gx[ni]!;
      const ty = gy[nj]!;
      // 每条网格边只检测一次（向右 / 向下记在左上那一端）。
      const link = dir === 0 || dir === 1 ? node : next;
      const across = dir === 0 || dir === 2;
      const cache = across ? rightOpen : downOpen;
      const penalty = across ? rightPenalty : downPenalty;
      if (cache[link] === 0) {
        if (blocked(x, y, tx, ty, -1)) {
          cache[link] = 2;
        } else {
          cache[link] = 1;
          penalty[link] = narrow(x, y, tx, ty);
        }
      }
      if (cache[link] === 2) continue;
      const length = Math.abs(tx - x) + Math.abs(ty - y);
      const step = length * (1 + penalty[link]!);
      relax(
        state,
        next * 4 + dir,
        cost + step + (dir === arrived ? 0 : BEND_COST),
      );
    }
  }

  if (!found) return fallback(request);

  // —— 回溯 ——
  const endState = parent[sink]!;
  const endAnchor = ends[endState - endBase]!;
  const trail: Position[] = [endAnchor.point];
  let state = parent[endState]!;
  let first = state;
  while (state >= 0) {
    const node = state >> 2;
    trail.push({ x: gx[node % nx]!, y: gy[Math.floor(node / nx)]! });
    first = state;
    state = parent[state]!;
  }
  const startAnchor = starts[startOf[first]!]!;
  trail.push(startAnchor.point);
  trail.reverse();
  return {
    points: smoothJogs(
      simplify(trail),
      (a, b, skip) => blocked(a.x, a.y, b.x, b.y, skip),
      (a, b) => narrow(a.x, a.y, b.x, b.y),
    ),
    sourceSide: startAnchor.side,
    targetSide: endAnchor.side,
  };
}

/** 小于这个的错台（Z 字里那一小段）拉平。 */
export const JOG_LIMIT = 12;

/**
 * 拉平小错台：两段同向的平行线之间只差几个单位时，把较短的那段挪到较长那段
 * 的线上（首段 / 末段连着节点不挪），挪完仍不碰障碍才算数。净距代价会让
 * 路线在节点边缘处换一次线，这一下换线在屏幕上只是一个难看的小台阶。
 */
export function smoothJogs(
  input: readonly Position[],
  hits: (a: Position, b: Position, skip: number) => boolean,
  score: (a: Position, b: Position) => number = () => 0,
): Position[] {
  let points = input.map((point) => ({ ...point }));
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let k = 1; k + 2 < points.length; k += 1) {
      const a = points[k - 1]!;
      const b = points[k]!;
      const c = points[k + 1]!;
      const d = points[k + 2]!;
      const jog = Math.abs(c.x - b.x) + Math.abs(c.y - b.y);
      if (jog === 0 || jog >= JOG_LIMIT) continue;
      const horizontal = a.y === b.y && c.y === d.y;
      const vertical = a.x === b.x && c.x === d.x;
      if (!horizontal && !vertical) continue;
      // 同向（Z），不是回头（U）。
      const forward = horizontal
        ? Math.sign(b.x - a.x) === Math.sign(d.x - c.x)
        : Math.sign(b.y - a.y) === Math.sign(d.y - c.y);
      if (!forward) continue;
      const firstFixed = k - 1 === 0;
      const lastFixed = k + 2 === points.length - 1;
      // 两种拉法：把 a-b 挪到 c-d 的线上，或反过来；挑合并后贴边罚更小的。
      let best: { next: Position[]; score: number } | null = null;
      for (const moveFirst of [true, false]) {
        if (moveFirst ? firstFixed : lastFixed) continue;
        const next = points.map((point) => ({ ...point }));
        if (moveFirst) {
          if (horizontal) next[k - 1]!.y = next[k]!.y = c.y;
          else next[k - 1]!.x = next[k]!.x = c.x;
        } else if (horizontal) {
          next[k + 1]!.y = next[k + 2]!.y = b.y;
        } else {
          next[k + 1]!.x = next[k + 2]!.x = b.x;
        }
        const span = moveFirst ? [k - 2, k - 1, k] : [k, k + 1, k + 2];
        const ok = span.every(
          (j) =>
            j < 0 ||
            j + 1 >= next.length ||
            !hits(
              next[j]!,
              next[j + 1]!,
              j === 0 ? 0 : j + 1 === next.length - 1 ? 1 : -1,
            ),
        );
        if (!ok) continue;
        const value = score(next[k - 1]!, next[k + 2]!);
        if (!best || value < best.score) best = { next, score: value };
      }
      if (!best) continue;
      const next = best.next;
      points = simplify(next);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return points;
}

/**
 * 折线的 SVG 路径：拐角是二次曲线，没有尖角（`smooth.ts`）。
 * `obstacles` 给了就让弧避开拐角内侧的节点。
 */
export function roundedPath(
  points: readonly Position[],
  radius: number = SOFT_RADIUS,
  obstacles: readonly Box[] = [],
): string {
  return softPath(points, obstacles, radius);
}

/** 折线上按弧长取一半处的点。 */
export function midpointOf(points: readonly Position[]): Position {
  let length = 0;
  for (let k = 1; k < points.length; k += 1) {
    length += Math.hypot(
      points[k]!.x - points[k - 1]!.x,
      points[k]!.y - points[k - 1]!.y,
    );
  }
  let remaining = length / 2;
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1]!;
    const b = points[k]!;
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (step >= remaining && step > 0) {
      const t = remaining / step;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= step;
  }
  return points[0] ?? { x: 0, y: 0 };
}
