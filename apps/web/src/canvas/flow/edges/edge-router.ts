import type { InternalNode, Node, ReactFlowState } from "@xyflow/react";
import type { CanvasEdgeRole, CanvasNode, Position } from "@armadra/shared";

import { dispatchAnchor, type Box, type LinkAnchor } from "../../geometry";
import { getDrafts } from "../drafts";
import { placeLabelOn, type LabelBox, type Stroke } from "./edge-label";
import { sameScene, sceneOf, type EdgeScene } from "./edge-scene";
import {
  ARROW_SIZE,
  CORNER_RADIUS,
  linkView,
  routeFor,
  type LinkView,
} from "./link-visual";
import { nudge, type NudgeInput } from "./nudge";
import { roundedPath, type SidePair } from "./route";
import { cornerCuts, smoothPath, type Cut } from "./smooth";

/**
 * 一张画布上所有连线的布局（#318）：路线、分道、标签，一处算、按边取。
 *
 * 为什么不各算各的：两条线走同一道缝时要错开（`nudge.ts`），两枚标签不能
 * 叠在一起——这两件事都得看见别的线。
 *
 * 为什么仍然快：
 *
 *  - 路线按边缓存，只有这条边的场景（两端 + 附近障碍，取整）变了才重算；
 *    拖一个节点时远处的线不重算，平移缩放时一条都不重算；
 *  - 分道与标签是全局的一遍扫描，只在有路线变了、字号或语言变了时跑；
 *  - 每条边拿到的是同一个对象，除非它的折线或标签真的变了——边组件用
 *    `useSyncExternalStore` 订阅，没变的边不重渲。
 *
 * 一个 React Flow 实例一个路由器（按 store 挂在 WeakMap 上）。
 */

export interface EdgeLayout {
  view: LinkView;
  /** 已翻译的标签文字；为空表示这条线不写字。 */
  text: string;
  /** 标签的位置与大小；放不下或缩放太小时为 `null`。 */
  label: LabelBox | null;
}

export interface LayoutParams {
  direction: "vertical" | "horizontal";
  /** 标签字号（画布单位）；0 表示不画标签。 */
  fontSize: number;
  t: (key: string) => string;
}

interface Shape {
  scene: EdgeScene;
  points: readonly Position[];
  cuts: Cut[];
}

interface Cached {
  scene: EdgeScene;
  key: string;
  view: LinkView;
  previous: SidePair;
}

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

function samePoints(a: readonly Position[], b: readonly Position[]): boolean {
  return (
    a.length === b.length &&
    a.every((point, i) => point.x === b[i]!.x && point.y === b[i]!.y)
  );
}

function sameLabel(a: LabelBox | null, b: LabelBox | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.fontSize === b.fontSize &&
    a.width === b.width
  );
}

export class EdgeRouter {
  private readonly store: StoreLike;
  private readonly cache = new Map<string, Cached>();
  private layouts = new Map<string, EdgeLayout | null>();
  private shapes = new Map<string, Shape>();
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
    return this.layouts.get(id) ?? null;
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
    // 拖动中只重算挂在被拖节点上的线；被它扫过的远处的线等松手再算
    // （松手时被拖的集合变空，指纹变了，这一轮就会补上）。
    const live = new Set<string>();
    const scenes = new Map<string, EdgeScene>();
    const views = new Map<string, LinkView>();
    const inputs: NudgeInput[] = [];

    for (const edge of state.edges) {
      if (edge.type !== "link" && edge.type !== "reference") continue;
      live.add(edge.id);
      const scene = sceneOf(nodeLookup, edge.source, edge.target);
      if (!scene) continue;
      const reference = edge.type === "reference";
      const role = reference
        ? undefined
        : (edge.data as { role?: CanvasEdgeRole } | undefined)?.role;
      const sourceType = typeOf(nodeLookup.get(edge.source));
      const targetType = typeOf(nodeLookup.get(edge.target));
      const supervises = role === "supervises";
      // 两端一动就重新选边（#211）：对等线就近边；派发线子在下游时按布局
      // 方向，被拖到主的上方 / 左侧时也改走就近边。
      const anchor: LinkAnchor = supervises
        ? dispatchAnchor(scene.source, scene.target, params.direction)
        : "free";
      const key = `${edge.type}|${role ?? ""}|${sourceType ?? ""}|${targetType ?? ""}|${anchor}`;
      const cached = this.cache.get(edge.id);
      let view: LinkView;
      const deferred =
        dragging.size > 0 &&
        !dragging.has(edge.source) &&
        !dragging.has(edge.target);
      if (
        cached &&
        cached.key === key &&
        (deferred || sameScene(cached.scene, scene))
      ) {
        view = cached.view;
        scenes.set(edge.id, cached.scene);
      } else {
        view = reference
          ? referenceView(scene, cached?.previous)
          : linkView(
              scene.source,
              scene.target,
              sourceType,
              targetType,
              role,
              anchor,
              { obstacles: scene.obstacles, previous: cached?.previous },
            );
        this.cache.set(edge.id, {
          scene,
          key,
          view,
          previous: {
            source: view.route.sourceSide,
            target: view.route.targetSide,
          },
        });
        scenes.set(edge.id, scene);
      }
      views.set(edge.id, view);
      inputs.push({
        id: edge.id,
        // 同一个主派出去的线共用主干，不必错开。
        bundle: supervises ? `dispatch:${edge.source}` : `edge:${edge.id}`,
        priority: supervises ? 0 : reference ? 2 : 1,
        points: view.route.points,
        obstacles: [scene.source, scene.target, ...scene.obstacles],
        source: {
          node: edge.source,
          side: view.route.sourceSide,
          box: scene.source,
        },
        target: {
          node: edge.target,
          side: view.route.targetSide,
          box: scene.target,
        },
      });
    }
    for (const id of this.cache.keys()) {
      if (!live.has(id)) this.cache.delete(id);
    }

    const nudged = nudge(inputs);

    // 标签：派发线先摆，其次上下文线、引用线；每枚都避开节点、箭头、已经摆好的
    // 标签与别的线。同一束（同一个主派出去的派发线）共用主干，只摆一枚。
    const order = [...inputs].sort((a, b) =>
      a.priority === b.priority
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : a.priority - b.priority,
    );
    const bundles = new Map<string, NudgeInput[]>();
    for (const input of order) {
      const list = bundles.get(input.bundle) ?? [];
      list.push(input);
      bundles.set(input.bundle, list);
    }
    // 折线与拐角的切入距离：曲线占掉的那一截不放标签，路径也用同一份。
    const shapes = new Map<string, Shape>();
    for (const input of inputs) {
      const points = nudged.get(input.id) ?? input.points;
      const scene = scenes.get(input.id)!;
      // 折线和附近障碍都没变就沿用上一次的切入距离（拖动时远处的线）。
      const old = this.shapes.get(input.id);
      shapes.set(
        input.id,
        old && old.scene === scene && samePoints(old.points, points)
          ? old
          : { scene, points, cuts: cornerCuts(points, scene.obstacles) },
      );
    }
    this.shapes = shapes;
    // 所有线两端的箭头都不能压（别的线的箭头也一样）。
    const tips: Box[] = [];
    const strokes: Stroke[] = [];
    for (const input of inputs) {
      const points = shapes.get(input.id)!.points;
      tips.push(tipBox(points[0]!), tipBox(points[points.length - 1]!));
      strokes.push(...strokeSegments(input.id, input.bundle, points));
    }
    const placed: Box[] = [...tips];
    const labels = new Map<string, LabelBox | null>();
    const texts = new Map<string, string>();
    for (const input of order) {
      const view = views.get(input.id)!;
      texts.set(input.id, view.labelKey ? params.t(view.labelKey) : "");
    }
    for (const group of bundles.values()) {
      const text = texts.get(group[0]!.id)!;
      for (const input of group) labels.set(input.id, null);
      if (params.fontSize <= 0 || text === "") continue;
      const first = scenes.get(group[0]!.id)!;
      const placement = placeLabelOn(
        group.map((input) => ({
          edge: input.id,
          bundle: input.bundle,
          points: shapes.get(input.id)!.points,
          cuts: shapes.get(input.id)!.cuts,
        })),
        text,
        params.fontSize,
        [
          ...group.flatMap((input) => {
            const scene = scenes.get(input.id)!;
            return [scene.source, scene.target];
          }),
          ...first.obstacles,
          ...placed,
        ],
        strokes,
      );
      if (!placement) continue;
      const { edge, ...label } = placement;
      labels.set(edge, label);
      // `placed` 前面是箭头，后面是已经摆好的标签。
      placed.push({
        x: label.x - label.width / 2,
        y: label.y - label.height / 2,
        width: label.width,
        height: label.height,
      });
    }
    const next = new Map<string, EdgeLayout | null>();
    for (const input of order) {
      const view = views.get(input.id)!;
      const { points, cuts } = shapes.get(input.id)!;
      const text = texts.get(input.id)!;
      const label = labels.get(input.id) ?? null;
      const previous = this.layouts.get(input.id);
      if (
        previous &&
        previous.view.labelKey === view.labelKey &&
        previous.view.arrowStart === view.arrowStart &&
        previous.view.arrowEnd === view.arrowEnd &&
        previous.text === text &&
        samePoints(previous.view.route.points, points) &&
        sameLabel(previous.label, label)
      ) {
        next.set(input.id, previous);
        continue;
      }
      const final: LinkView = {
        ...view,
        route: { ...view.route, points: [...points] },
        d: smoothPath(points, cuts),
      };
      next.set(input.id, { view: final, text, label });
    }
    this.layouts = next;
  }
}

/** 线条的粗细（含描边与一点余量），标签按这个宽度避开别的线。 */
const STROKE_BAND = 3;

/** 折线每一段（带身份与细长外框），标签据此判断有没有被线穿过。 */
function strokeSegments(
  edge: string,
  bundle: string,
  points: readonly Position[],
): Stroke[] {
  const out: Stroke[] = [];
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1]!;
    const b = points[k]!;
    const horizontal = a.y === b.y;
    out.push({
      edge,
      k,
      bundle,
      horizontal,
      at: horizontal ? a.y : a.x,
      box: {
        x: Math.min(a.x, b.x) - STROKE_BAND,
        y: Math.min(a.y, b.y) - STROKE_BAND,
        width: Math.abs(b.x - a.x) + STROKE_BAND * 2,
        height: Math.abs(b.y - a.y) + STROKE_BAND * 2,
      },
    });
  }
  return out;
}

/** 端点处箭头占的那一小块。 */
function tipBox(point: Position): Box {
  return {
    x: point.x - ARROW_SIZE,
    y: point.y - ARROW_SIZE,
    width: ARROW_SIZE * 2,
    height: ARROW_SIZE * 2,
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
