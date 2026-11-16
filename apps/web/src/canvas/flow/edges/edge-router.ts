import type { InternalNode, Node, ReactFlowState } from "@xyflow/react";
import type { CanvasEdgeRole, CanvasNode } from "@armadra/shared";
import {
  dispatchAnchor,
  EdgeLayoutEngine,
  roundedPath,
  routeFor,
  type EdgeLayout as CoreLayout,
  type EdgePlan,
  type LinkAnchor,
  type SceneNode,
  type SidePair,
  type EdgeScene,
} from "@armadra/board/core";

import { getDrafts } from "../drafts";
import {
  ARROW_SIZE,
  CORNER_RADIUS,
  linkView,
  type LinkView,
} from "./link-visual";

/**
 * 一张画布上所有连线的布局（#318）：路线、分道、标签，一处算、按边取。
 *
 * 计算本体在引擎 core 的 `EdgeLayoutEngine`（路线缓存、分道、标签避让）；
 * 这里只是 React Flow 一侧的薄适配：把节点表与边表翻成引擎的输入，
 * 判断「有没有东西变了」（节点指纹、边表引用、参数），再把结果按边交出去。
 * 一个 React Flow 实例一个路由器（按 store 挂在 WeakMap 上）。
 */

export type EdgeLayout = CoreLayout<LinkView>;

export interface LayoutParams {
  direction: "vertical" | "horizontal";
  /** 标签字号（画布单位）；0 表示不画标签。 */
  fontSize: number;
  t: (key: string) => string;
}

/** 不当障碍的节点：分组框（线本来就要穿进穿出）、墨迹与直线（形状不规则）。 */
const PASS_THROUGH = new Set(["group", "wb.ink", "wb.line"]);

type StoreLike = {
  getState: () => ReactFlowState;
  subscribe: (listener: () => void) => () => void;
};

function typeOf(node: InternalNode<Node> | undefined): string | undefined {
  return (node?.data as CanvasNode | undefined)?.type;
}

/**
 * 正在被拖动 / 缩放的节点：React Flow 自己的 `dragging`，加上画布拖动时写的
 * 草稿（`flow/drafts.ts`，投影出来的节点上没有 `dragging`）。
 */
function activeNodes(state: ReactFlowState): Set<string> {
  const active = new Set<string>(getDrafts().keys());
  for (const [id, node] of state.nodeLookup) {
    if (node.dragging) active.add(id);
  }
  return active;
}

/** 节点几何的指纹：任何一个节点挪了、改了尺寸、显隐变了，它就变。 */
function fingerprint(state: ReactFlowState, active: Set<string>): number {
  let hash = state.nodeLookup.size;
  for (const id of active) {
    for (let i = 0; i < id.length; i += 1) {
      hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
    }
  }
  for (const node of state.nodeLookup.values()) {
    const { x, y } = node.internals.positionAbsolute;
    const width = node.measured.width ?? node.width ?? 0;
    const height = node.measured.height ?? node.height ?? 0;
    for (const value of [x, y, width, height, node.hidden ? 1 : 0]) {
      hash = (Math.imul(hash, 31) + Math.round(value)) | 0;
    }
  }
  return hash;
}

type LinkEdge = ReactFlowState["edges"][number];

/** 节点的取整绝对矩形；还没量到尺寸时退回投影给的宽高。 */
function sceneNode(node: InternalNode<Node>): SceneNode {
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  const box =
    width > 0 && height > 0
      ? {
          x: Math.round(node.internals.positionAbsolute.x),
          y: Math.round(node.internals.positionAbsolute.y),
          width: Math.round(width),
          height: Math.round(height),
        }
      : null;
  return {
    box,
    obstacle: !node.hidden && !PASS_THROUGH.has(node.type ?? ""),
  };
}

export class EdgeRouter {
  private readonly store: StoreLike;
  private readonly engine = new EdgeLayoutEngine<LinkEdge, LinkView>();
  private lastState: ReactFlowState | null = null;
  private lastFingerprint = NaN;
  private lastEdges: unknown = null;
  private lastParams: LayoutParams | null = null;

  constructor(store: StoreLike) {
    this.store = store;
  }

  subscribe = (listener: () => void): (() => void) =>
    this.store.subscribe(listener);

  /** 某条边的布局；不存在或两端还没尺寸时为 `null`。 */
  read(id: string, params: LayoutParams): EdgeLayout | null {
    this.update(params);
    return this.engine.get(id);
  }

  private update(params: LayoutParams): void {
    const state = this.store.getState();
    const last = this.lastParams;
    const paramsSame =
      last !== null &&
      last.direction === params.direction &&
      last.fontSize === params.fontSize &&
      last.t === params.t;
    if (state === this.lastState && paramsSame) return;
    this.lastState = state;
    const active = activeNodes(state);
    const print = fingerprint(state, active);
    if (
      paramsSame &&
      print === this.lastFingerprint &&
      state.edges === this.lastEdges
    ) {
      return;
    }
    this.lastFingerprint = print;
    this.lastEdges = state.edges;
    this.lastParams = params;
    this.recompute(state, params, active);
  }

  private recompute(
    state: ReactFlowState,
    params: LayoutParams,
    dragging: Set<string>,
  ): void {
    const { nodeLookup } = state;
    const nodes = new Map<string, SceneNode>();
    for (const [id, node] of nodeLookup) nodes.set(id, sceneNode(node));
    this.engine.recompute({
      edges: state.edges.filter(
        (edge) => edge.type === "link" || edge.type === "reference",
      ),
      nodes,
      dragging,
      fontSize: params.fontSize,
      tipSize: ARROW_SIZE,
      translate: params.t,
      plan: (edge, scene) => planOf(edge, scene, nodeLookup, params),
    });
  }
}

/** 一条边怎么画：两端一动就重新选边（#211），派发线同束、先摆标签。 */
function planOf(
  edge: LinkEdge,
  scene: EdgeScene,
  nodeLookup: ReadonlyMap<string, InternalNode<Node>>,
  params: LayoutParams,
): EdgePlan<LinkView> {
  const reference = edge.type === "reference";
  const role = reference
    ? undefined
    : (edge.data as { role?: CanvasEdgeRole } | undefined)?.role;
  const sourceType = typeOf(nodeLookup.get(edge.source));
  const targetType = typeOf(nodeLookup.get(edge.target));
  const supervises = role === "supervises";
  // 对等线就近边；派发线子在下游时按布局方向，被拖到主的上方 / 左侧时也改走就近边。
  const anchor: LinkAnchor = supervises
    ? dispatchAnchor(scene.source, scene.target, params.direction)
    : "free";
  return {
    key: `${edge.type}|${role ?? ""}|${sourceType ?? ""}|${targetType ?? ""}|${anchor}`,
    // 同一个主派出去的线共用主干，不必错开。
    bundle: supervises ? `dispatch:${edge.source}` : `edge:${edge.id}`,
    priority: supervises ? 0 : reference ? 2 : 1,
    view: (previous) =>
      reference
        ? referenceView(scene, previous)
        : linkView(
            scene.source,
            scene.target,
            sourceType,
            targetType,
            role,
            anchor,
            { obstacles: scene.obstacles, previous },
          ),
  };
}

/** 引用线：与上下文线同一套路由，箭头只指向节点，标签「引用」。 */
function referenceView(scene: EdgeScene, previous?: SidePair): LinkView {
  const route = routeFor(
    scene.source,
    scene.target,
    scene.obstacles,
    "free",
    previous,
  );
  return {
    route,
    d: roundedPath(route.points, CORNER_RADIUS, scene.obstacles),
    labelKey: "edge.reference",
    arrowStart: false,
    arrowEnd: true,
  };
}

const routers = new WeakMap<object, EdgeRouter>();

/** 这个 React Flow 实例的路由器（第一次用时建）。 */
export function routerFor(store: StoreLike): EdgeRouter {
  let router = routers.get(store);
  if (!router) {
    router = new EdgeRouter(store);
    routers.set(store, router);
  }
  return router;
}
