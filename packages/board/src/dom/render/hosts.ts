// 世界层宿主：每个 world 层实体一个 div，供 React 绑定 createPortal。
// 只追加、不重排：层级一律用 z-index，内嵌网页与终端的 DOM 相对顺序因此永不变化。
import type { Entity, EntityId, Scene } from "../../core";
import type { DomKindSpec } from "../types";

export interface HostChange {
  added: readonly EntityId[];
  removed: readonly EntityId[];
}

export interface WorldHosts {
  hostOf(id: EntityId): HTMLElement | undefined;
  /** 宿主新增 / 移除的通知（宿主元素移除之后才通知）。 */
  subscribe(listener: (change: HostChange) => void): () => void;
  destroy(): void;
}

export interface WorldHostsDeps {
  world: HTMLElement;
  scene: Scene;
  kind(kind: string): Pick<DomKindSpec, "layer"> | undefined;
}

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export function createWorldHosts(deps: WorldHostsDeps): WorldHosts {
  const { world, scene } = deps;
  const hosts = new Map<EntityId, HTMLElement>();
  const placed = new Map<EntityId, Placed>();
  const listeners = new Set<(change: HostChange) => void>();
  let rankedFor: readonly Entity[] | null = null;

  const isWorld = (entity: Entity): boolean =>
    (deps.kind(entity.kind)?.layer ?? "world") === "world";

  function place(id: EntityId, host: HTMLElement): void {
    // 绝对世界坐标（已叠加父级偏移与预览），取整与节点现有的取整一致。
    const box = scene.bounds(id);
    if (!box) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const prev = placed.get(id);
    const next = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.w),
      h: Math.round(box.h),
      z: prev?.z ?? 0,
    };
    placed.set(id, next);
    // 位置用 transform 而不是 left / top：拖动只触发合成，不再每步重排宿主里的终端。
    if (prev?.x !== next.x || prev?.y !== next.y) {
      host.style.transform = `translate(${next.x}px, ${next.y}px)`;
    }
    if (prev?.w !== next.w) host.style.width = `${next.w}px`;
    if (prev?.h !== next.h) host.style.height = `${next.h}px`;
  }

  function sync(changed: Iterable<EntityId>): void {
    const added: EntityId[] = [];
    const removed: EntityId[] = [];
    for (const id of changed) {
      const entity = scene.get(id);
      let host = hosts.get(id);
      if (!entity || !isWorld(entity)) {
        if (host) {
          host.remove();
          hosts.delete(id);
          placed.delete(id);
          removed.push(id);
        }
        continue;
      }
      if (!host) {
        host = document.createElement("div");
        host.dataset.boardId = id;
        host.dataset.boardKind = entity.kind;
        host.style.cssText = "position:absolute;left:0;top:0";
        hosts.set(id, host);
        world.append(host);
        added.push(id);
      }
      place(id, host);
    }
    const ordered = scene.ordered();
    if (ordered !== rankedFor || added.length > 0) {
      rankedFor = ordered;
      let rank = 0;
      for (const entity of ordered) {
        const host = hosts.get(entity.id);
        const state = placed.get(entity.id);
        if (!host || !state) continue;
        rank += 1;
        if (state.z !== rank) {
          state.z = rank;
          host.style.zIndex = String(rank);
        }
      }
    }
    if (added.length + removed.length === 0) return;
    for (const listener of [...listeners]) listener({ added, removed });
  }

  sync(scene.ordered().map((entity) => entity.id));
  const stop = scene.subscribe(sync);

  return {
    hostOf: (id) => hosts.get(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      stop();
      listeners.clear();
      for (const host of hosts.values()) host.remove();
      hosts.clear();
      placed.clear();
    },
  };
}
