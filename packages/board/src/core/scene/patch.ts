// 补丁：一次改动碰过的实体及其前后样子（docs/design/board-engine.md §2.4）。
// `id → 实体 | null`，null 表示那一刻不存在；撤销就是把 before 写回去。
import type { Entity, EntityId } from "../types";

export type EntityState<D = unknown> = Entity<D> | null;

export interface Patch<D = unknown> {
  readonly before: ReadonlyMap<EntityId, EntityState<D>>;
  readonly after: ReadonlyMap<EntityId, EntityState<D>>;
}

export function emptyPatch<D = unknown>(): Patch<D> {
  return { before: new Map(), after: new Map() };
}

export function isEmptyPatch(patch: Patch<never> | Patch): boolean {
  return patch.before.size === 0 && patch.after.size === 0;
}

/** 逆补丁：前后对调。 */
export function invertPatch<D>(patch: Patch<D>): Patch<D> {
  return { before: patch.after, after: patch.before };
}

/**
 * 先 `first` 再 `second` 合成一条：最早的「改之前」才是 before，最后的「改之后」才是 after。
 * 合成后前后是同一个引用（含都不存在）的 id 没有净变化，丢掉。
 */
export function composePatch<D>(first: Patch<D>, second: Patch<D>): Patch<D> {
  const before = new Map(first.before);
  for (const [id, value] of second.before) {
    if (!before.has(id)) before.set(id, value);
  }
  const after = new Map(first.after);
  for (const [id, value] of second.after) after.set(id, value);
  for (const [id, value] of before) {
    if (after.get(id) === value) {
      before.delete(id);
      after.delete(id);
    }
  }
  return { before, after };
}

/**
 * 两份实体列表的差异，按**对象身份**比较：没动过的实体仍是同一个引用，
 * 所以成本与变动条数成正比。同一个数组引用直接返回空补丁。
 */
export function diffEntities<D>(
  before: readonly Entity<D>[],
  after: readonly Entity<D>[],
): Patch<D> {
  if (before === after) return emptyPatch();
  const from = new Map(before.map((entity) => [entity.id, entity]));
  const to = new Map(after.map((entity) => [entity.id, entity]));
  const patch = {
    before: new Map<EntityId, EntityState<D>>(),
    after: new Map<EntityId, EntityState<D>>(),
  };
  for (const [id, entity] of from) {
    const next = to.get(id);
    if (next === entity) continue;
    patch.before.set(id, entity);
    patch.after.set(id, next ?? null);
  }
  for (const [id, entity] of to) {
    if (from.has(id)) continue;
    patch.before.set(id, null);
    patch.after.set(id, entity);
  }
  return patch;
}
