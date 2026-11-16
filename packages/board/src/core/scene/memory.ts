// 独立使用的可写场景：实体表 + 事务 + 预览提交 + 撤销（展示页、测试、独立演示）。
import type { Entity, EntityId } from "../types";
import { createHistory } from "./history";
import { invertPatch, type EntityState, type Patch } from "./patch";
import { createSceneCore } from "./store";
import type {
  MemoryScene,
  SceneDraft,
  SceneOptions,
  TransactOptions,
} from "./types";

export function createMemoryScene<D = unknown>(
  options?: SceneOptions,
): MemoryScene<D> {
  const core = createSceneCore<D>(options);
  const history = createHistory<D>({
    replay: (patch) => {
      core.write(patch.after);
    },
  });

  /** 写入并按选项记历史；返回实际发生的前后。 */
  function commit(
    after: ReadonlyMap<EntityId, EntityState<D>>,
    { history: mode = "record", label = "edit" }: TransactOptions = {},
    extra?: Iterable<EntityId>,
  ): Patch<D> {
    const patch = core.write(after, extra);
    if (mode === "record") history.record({ label, ...patch });
    return patch;
  }

  function transact(
    mutate: (draft: SceneDraft<D>) => void,
    transactOptions?: TransactOptions,
  ): Patch<D> {
    const pending = new Map<EntityId, EntityState<D>>();
    const read = (id: EntityId): Entity<D> | undefined =>
      pending.has(id) ? (pending.get(id) ?? undefined) : core.get(id);
    mutate({
      get: read,
      set: (entity) => void pending.set(entity.id, entity),
      update(id, changes) {
        const current = read(id);
        if (!current) return false;
        pending.set(id, { ...current, ...changes });
        return true;
      },
      remove: (id) => void pending.set(id, null),
    });
    return commit(pending, transactOptions);
  }

  return {
    ...core,
    get size() {
      return core.size;
    },
    transact,
    apply: (patch, applyOptions) =>
      invertPatch(commit(patch.after, applyOptions)),
    commitPreview(commitOptions) {
      const after = new Map<EntityId, EntityState<D>>();
      const taken = core.takePreview();
      for (const [id, geometry] of taken) {
        const current = core.get(id);
        if (current) after.set(id, { ...current, ...geometry });
      }
      return commit(after, commitOptions, taken.keys());
    },
    undo: () => history.undo(),
    redo: () => history.redo(),
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    beginCoalesce: (label) => history.beginCoalesce(label),
    endCoalesce: () => history.endCoalesce(),
    subscribeHistory: (listener) => history.subscribe(listener),
    resetHistory: () => history.reset(),
  };
}
