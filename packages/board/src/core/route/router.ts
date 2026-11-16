import type { Vec } from "../types";
import type { Box } from "./anchor";
import { placeLabelOn, type LabelBox, type Stroke } from "./label";
import { nudge, type NudgeInput } from "./nudge";
import type { Route, SidePair } from "./route";
import { sameScene, sceneOf, type EdgeScene, type SceneNode } from "./scene";
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
 *  - 分道与标签是全局的一遍扫描，只在调用方说有东西变了时跑；
 *  - 每条边拿到的是同一个对象，除非它的折线或标签真的变了。
 *
 * 引擎不认识节点类型、角色、翻译：线画成什么样（路线、箭头、标签键）由调用方的
 * {@link EdgePlan} 给出。
 */

/** 一条线画成什么样的最小形状；调用方的视图类型可以带更多字段。 */
export interface RoutedView {
  route: Route;
  /** 给 `<path>` 的路径（折线 + 圆角）。 */
  d: string;
  /** 常驻标签的文案键。 */
  labelKey: string | null;
  arrowStart: boolean;
  arrowEnd: boolean;
}

export interface EdgeLayout<V extends RoutedView = RoutedView> {
  view: V;
  /** 已翻译的标签文字；为空表示这条线不写字。 */
  text: string;
  /** 标签的位置与大小；放不下或缩放太小时为 `null`。 */
  label: LabelBox | null;
}

export interface RoutedEdge {
  id: string;
  source: string;
  target: string;
}

/** 调用方对一条边的判断：缓存键、同束与优先级、怎么画。 */
export interface EdgePlan<V extends RoutedView> {
  /** 这个串变了就重画（边的种类、角色、两端类型、取边规则）。 */
  key: string;
  /** 同束的线共用主干：分道时不必错开，标签只摆一枚。 */
  bundle: string;
  /** 越小越先摆标签。 */
  priority: number;
  view(previous: SidePair | undefined): V;
}

export interface LayoutInput<E extends RoutedEdge, V extends RoutedView> {
  edges: readonly E[];
  nodes: ReadonlyMap<string, SceneNode>;
  /** 正在被拖动 / 缩放的节点。 */
  dragging: ReadonlySet<string>;
  /** 标签字号（画布单位）；0 表示不画标签。 */
  fontSize: number;
  /** 端点处箭头占的半边长，标签据此避开箭头。 */
  tipSize: number;
  plan(edge: E, scene: EdgeScene): EdgePlan<V>;
  translate(labelKey: string): string;
}

interface Shape {
  scene: EdgeScene;
  points: readonly Vec[];
  cuts: Cut[];
}

interface Cached<V> {
  scene: EdgeScene;
  key: string;
  view: V;
  previous: SidePair;
}

function samePoints(a: readonly Vec[], b: readonly Vec[]): boolean {
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

export class EdgeLayoutEngine<
  E extends RoutedEdge = RoutedEdge,
  V extends RoutedView = RoutedView,
> {
  private readonly cache = new Map<string, Cached<V>>();
  private layouts = new Map<string, EdgeLayout<V> | null>();
  private shapes = new Map<string, Shape>();

  /** 某条边的布局；不存在或两端还没尺寸时为 `null`。 */
  get(id: string): EdgeLayout<V> | null {
    return this.layouts.get(id) ?? null;
  }

  /** 重算全部连线；被拖动的节点见 {@link LayoutInput.dragging}。 */
  recompute(layout: LayoutInput<E, V>): void {
    const { nodes, dragging, edges } = layout;
    // 拖动中只重算挂在被拖节点上的线；被它扫过的远处的线等松手再算
    // （松手时被拖的集合变空，指纹变了，这一轮就会补上）。
    const live = new Set<string>();
    const scenes = new Map<string, EdgeScene>();
    const views = new Map<string, V>();
    const inputs: NudgeInput[] = [];

    for (const edge of edges) {
      live.add(edge.id);
      const scene = sceneOf(nodes, edge.source, edge.target);
      if (!scene) continue;
      const plan = layout.plan(edge, scene);
      const { key } = plan;
      const cached = this.cache.get(edge.id);
      let view: V;
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
        view = plan.view(cached?.previous);
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
        bundle: plan.bundle,
        priority: plan.priority,
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
    const tip = layout.tipSize;
    const tips: Box[] = [];
    const strokes: Stroke[] = [];
    for (const input of inputs) {
      const points = shapes.get(input.id)!.points;
      tips.push(
        tipBox(points[0]!, tip),
        tipBox(points[points.length - 1]!, tip),
      );
      strokes.push(...strokeSegments(input.id, input.bundle, points));
    }
    const placed: Box[] = [...tips];
    const labels = new Map<string, LabelBox | null>();
    const texts = new Map<string, string>();
    for (const input of order) {
      const view = views.get(input.id)!;
      texts.set(input.id, view.labelKey ? layout.translate(view.labelKey) : "");
    }
    for (const group of bundles.values()) {
      const text = texts.get(group[0]!.id)!;
      for (const input of group) labels.set(input.id, null);
      if (layout.fontSize <= 0 || text === "") continue;
      const first = scenes.get(group[0]!.id)!;
      const placement = placeLabelOn(
        group.map((input) => ({
          edge: input.id,
          bundle: input.bundle,
          points: shapes.get(input.id)!.points,
          cuts: shapes.get(input.id)!.cuts,
        })),
        text,
        layout.fontSize,
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
    const next = new Map<string, EdgeLayout<V> | null>();
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
      const final: V = {
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
  points: readonly Vec[],
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
function tipBox(point: Vec, size: number): Box {
  return {
    x: point.x - size,
    y: point.y - size,
    width: size * 2,
    height: size * 2,
  };
}
