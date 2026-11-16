// 场景实体表：对象身份、按父分组、按层与 z 的有序视图、预览与批量通知。
import type { Entity, EntityId, Layer, Rect, Vec } from "../types";
import type { EntityState, Patch } from "./patch";
import {
  LAYER_ORDER,
  type Geometry,
  type PreviewChanges,
  type Scene,
  type SceneOptions,
} from "./types";

type Listener = (changed: ReadonlySet<EntityId>) => void;

/** 在 `Scene` 之上多出的、只给 `MemoryScene` 用的写口。 */
export interface SceneCore<D> extends Scene<D> {
  /**
   * 写入 `after`：只写真有变化的；返回实际的前后（逆补丁取它）。
   * `extra` 是这次一并要通知的 id（例如同时清掉的预览）。
   */
  write(
    after: ReadonlyMap<EntityId, EntityState<D>>,
    extra?: Iterable<EntityId>,
  ): Patch<D>;
  /** 取走全部预览并清空，不通知；由调用方并进下一次 `write` 的通知。 */
  takePreview(): Map<EntityId, Partial<Geometry>>;
}

const layerIndex = (layer: Layer): number => LAYER_ORDER.indexOf(layer);

export function createSceneCore<D = unknown>(
  options: SceneOptions = {},
): SceneCore<D> {
  const table = new Map<EntityId, Entity<D>>();
  const byParent = new Map<EntityId | undefined, Set<EntityId>>();
  /** 端点 → 以它为端点的连接类实体。 */
  const byEnd = new Map<EntityId, Set<EntityId>>();
  const previews = new Map<EntityId, Partial<Geometry>>();
  const listeners = new Set<Listener>();
  let orderedCache: readonly Entity<D>[] | null = null;

  const layerOf = (kind: string): Layer =>
    options.kinds?.(kind)?.layer ?? "world";

  function link(entity: Entity<D>): void {
    let siblings = byParent.get(entity.parent);
    if (!siblings) byParent.set(entity.parent, (siblings = new Set()));
    siblings.add(entity.id);
    for (const end of entity.ends ?? []) {
      let lines = byEnd.get(end);
      if (!lines) byEnd.set(end, (lines = new Set()));
      lines.add(entity.id);
    }
  }

  function unlink(entity: Entity<D>): void {
    byParent.get(entity.parent)?.delete(entity.id);
    for (const end of entity.ends ?? []) byEnd.get(end)?.delete(entity.id);
  }

  /** 把 `ids` 扩成「受影响」集合：加上随父级移动的子孙与相连的连接类实体。 */
  function expand(ids: Iterable<EntityId>): Set<EntityId> {
    const out = new Set<EntityId>();
    const visit = (id: EntityId): void => {
      if (out.has(id)) return;
      out.add(id);
      for (const child of byParent.get(id) ?? []) visit(child);
      for (const line of byEnd.get(id) ?? []) visit(line);
    };
    for (const id of ids) visit(id);
    return out;
  }

  function emit(changed: Set<EntityId>): void {
    if (changed.size === 0) return;
    for (const listener of [...listeners]) listener(changed);
  }

  /** 自己的几何（叠加预览）。 */
  function own(entity: Entity<D>): Geometry {
    const preview = previews.get(entity.id);
    return preview ? { ...pick(entity), ...preview } : pick(entity);
  }

  function offset(entity: Entity<D>): Vec {
    let x = 0;
    let y = 0;
    const seen = new Set<EntityId>([entity.id]);
    for (
      let parent =
        entity.parent === undefined ? undefined : table.get(entity.parent);
      parent && !seen.has(parent.id);
      parent =
        parent.parent === undefined ? undefined : table.get(parent.parent)
    ) {
      seen.add(parent.id);
      const g = own(parent);
      x += g.x;
      y += g.y;
    }
    return { x, y };
  }

  function boundsOf(entity: Entity<D>, depth = 0): Rect | undefined {
    if (entity.ends) {
      if (depth > 0) return undefined;
      const [a, b] = entity.ends.map((end) => {
        const target = table.get(end);
        return target && !target.ends ? boundsOf(target, 1) : undefined;
      });
      return a && b ? union(a, b) : undefined;
    }
    const g = own(entity);
    const o = offset(entity);
    return { x: g.x + o.x, y: g.y + o.y, w: g.w, h: g.h };
  }

  function ordered(): readonly Entity<D>[] {
    orderedCache ??= [...table.values()]
      .map((entity, order) => ({ entity, order }))
      .sort(
        (a, b) =>
          layerIndex(layerOf(a.entity.kind)) -
            layerIndex(layerOf(b.entity.kind)) ||
          a.entity.z - b.entity.z ||
          a.order - b.order,
      )
      .map(({ entity }) => entity);
    return orderedCache;
  }

  const core: SceneCore<D> = {
    get: (id) => table.get(id),
    has: (id) => table.has(id),
    get size() {
      return table.size;
    },
    children(parent) {
      const ids = byParent.get(parent);
      if (!ids) return [];
      return [...ids].map((id) => table.get(id)!).sort((a, b) => a.z - b.z);
    },
    ordered,
    bounds(id) {
      const entity = table.get(id);
      return entity && boundsOf(entity);
    },
    query(area, filter) {
      const out: Entity<D>[] = [];
      for (const entity of ordered()) {
        const box = boundsOf(entity);
        if (!box || !touches(box, area)) continue;
        if (!filter || filter(entity)) out.push(entity);
      }
      return out;
    },
    hit(point, hitOptions = {}) {
      const tolerance = hitOptions.tolerance ?? 0;
      const layers = hitOptions.layers;
      const list = ordered();
      for (let i = list.length - 1; i >= 0; i--) {
        const entity = list[i]!;
        if (layers && !layers.includes(layerOf(entity.kind))) continue;
        const box = boundsOf(entity);
        if (!box || !contains(box, point, tolerance)) continue;
        const exact = options.kinds?.(entity.kind)?.hit;
        // 精确命中收到的是绝对几何：实体自己的 x/y 相对父级，规则看不懂父级。
        if (exact && !exact({ ...entity, ...box }, point, tolerance)) continue;
        return entity;
      }
      return undefined;
    },
    sync(patch) {
      core.write(patch.after);
    },
    write(after, extra = []) {
      const before = new Map<EntityId, EntityState<D>>();
      const applied = new Map<EntityId, EntityState<D>>();
      const touched = new Set<EntityId>();
      for (const [id, next] of after) {
        const current = table.get(id) ?? null;
        if (current === next) continue;
        before.set(id, current);
        applied.set(id, next);
        touched.add(id);
        if (current) unlink(current);
        if (next) {
          table.set(id, next);
          link(next);
        } else {
          table.delete(id);
        }
      }
      if (applied.size > 0) orderedCache = null;
      for (const id of extra) touched.add(id);
      emit(expand(touched));
      return { before, after: applied };
    },
    preview(changes: PreviewChanges) {
      const changed = new Set<EntityId>();
      for (const [id, partial] of changes) {
        const previous = previews.get(id);
        const merged = { ...previous, ...partial };
        if (previous && sameGeometry(previous, merged)) continue;
        previews.set(id, merged);
        changed.add(id);
      }
      emit(expand(changed));
    },
    clearPreview(ids) {
      const targets = ids ?? [...previews.keys()];
      const changed = new Set<EntityId>();
      for (const id of targets) if (previews.delete(id)) changed.add(id);
      emit(expand(changed));
    },
    takePreview() {
      const taken = new Map(previews);
      previews.clear();
      return taken;
    },
    previewOf: (id) => previews.get(id),
    gestureActive: () => previews.size > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return core;
}

/** 只读 / 外部同步用的场景：不带撤销。 */
export function createScene<D = unknown>(options?: SceneOptions): Scene<D> {
  return createSceneCore<D>(options);
}

function pick(entity: Entity<unknown>): Geometry {
  return { x: entity.x, y: entity.y, w: entity.w, h: entity.h };
}

function sameGeometry(a: Partial<Geometry>, b: Partial<Geometry>): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function touches(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  );
}

function contains(box: Rect, p: Vec, tolerance: number): boolean {
  return (
    p.x >= box.x - tolerance &&
    p.x <= box.x + box.w + tolerance &&
    p.y >= box.y - tolerance &&
    p.y <= box.y + box.h + tolerance
  );
}
