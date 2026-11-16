import type { CanvasNode } from "@armadra/shared";
import {
  EdgeLayoutEngine,
  type Entity,
  type SceneNode,
} from "@armadra/board/core";
import type { DomBoard } from "@armadra/board/dom";

import {
  PASS_THROUGH,
  planOf,
  type EdgeLayout,
  type LayoutParams,
  type PlannedEdge,
} from "../flow/edges/edge-plan";
import { ARROW_SIZE, type LinkView } from "../flow/edges/link-visual";
import { edgeDataOf } from "./edge-model";

/**
 * 自研引擎下全画布的连线布局：与旧引擎的 `EdgeRouter` 同一个核心
 * （`EdgeLayoutEngine`）和同一份取边规则（`edge-plan.ts`），只是输入从
 * React Flow 的节点表换成引擎场景。
 *
 * 场景里的盒子已经叠加父级偏移与手势预览，所以拖动中连线跟着节点走；
 * 正在被预览的实体就是引擎需要的「正在拖动」集合。
 *
 * 重算是惰性的：场景或参数变了只记一笔，第一个来读布局的连线触发一次全表
 * 计算，同一轮里其余的连线读缓存。
 */

export type { EdgeLayout, LayoutParams };

type BoardEdge = PlannedEdge & { type: string };

export class BoardEdgeRouter {
  private readonly engine = new EdgeLayoutEngine<BoardEdge, LinkView>();
  private readonly listeners = new Set<() => void>();
  private dirty = true;
  private params: LayoutParams | null = null;
  private stop: () => void;

  constructor(private readonly board: DomBoard<CanvasNode>) {
    this.stop = board.scene.subscribe(() => {
      this.dirty = true;
      for (const listener of [...this.listeners]) listener();
    });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 全部连线的 id（场景里带 `ends` 的实体），按场景顺序。 */
  edges(): readonly Entity<CanvasNode>[] {
    return this.board.scene.ordered().filter((entity) => entity.ends);
  }

  /** 某条边的布局；不存在或两端还没尺寸时为 `null`。 */
  read(id: string, params: LayoutParams): EdgeLayout | null {
    const last = this.params;
    if (
      last === null ||
      last.direction !== params.direction ||
      last.fontSize !== params.fontSize ||
      last.t !== params.t
    ) {
      this.params = params;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.recompute(params);
    }
    return this.engine.get(id);
  }

  /** 用上一次读时的参数取布局（命中测试用，不触发参数变化）。 */
  current(id: string): EdgeLayout | null {
    return this.params ? this.read(id, this.params) : null;
  }

  private recompute(params: LayoutParams): void {
    const { scene } = this.board;
    const nodes = new Map<string, SceneNode>();
    const dragging = new Set<string>();
    const types = new Map<string, string | undefined>();
    const edges: BoardEdge[] = [];
    for (const entity of scene.ordered()) {
      if (entity.ends) {
        const data = edgeDataOf(entity);
        edges.push({
          id: entity.id,
          source: entity.ends[0],
          target: entity.ends[1],
          type: data.type,
          data,
        });
        continue;
      }
      if (scene.previewOf(entity.id)) dragging.add(entity.id);
      const bounds = scene.bounds(entity.id);
      const box =
        bounds && bounds.w > 0 && bounds.h > 0
          ? {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.round(bounds.w),
              height: Math.round(bounds.h),
            }
          : null;
      nodes.set(entity.id, {
        box,
        obstacle: !PASS_THROUGH.has(entity.kind),
      });
      types.set(entity.id, (entity.data as CanvasNode | undefined)?.type);
    }
    this.engine.recompute({
      edges,
      nodes,
      dragging,
      fontSize: params.fontSize,
      tipSize: ARROW_SIZE,
      translate: params.t,
      plan: (edge, sceneOf) =>
        planOf(edge, sceneOf, (id) => types.get(id), params),
    });
  }
}

const routers = new WeakMap<object, BoardEdgeRouter>();

/** 这块板的路由器（第一次用时建，随板的 GC 一起走）。 */
export function edgeRouterFor(board: DomBoard<CanvasNode>): BoardEdgeRouter {
  let router = routers.get(board);
  if (!router) {
    router = new BoardEdgeRouter(board);
    routers.set(board, router);
  }
  return router;
}
