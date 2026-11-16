// 撤销 / 重做栈（docs/design/board-engine.md §2.4），由 `apps/web/src/store/canvas/history.ts`
// 泛化而来，语义不变：
//
//  1. 远端灌入不进栈：调用方不 `record` 即可（`Scene.sync`、`transact(.., { history: "ignore" })`）。
//  2. 撤销只回放这条记录 `before` 里出现的实体；期间远端新增的不受影响，
//     被远端删掉的会复活为本地新建。
//  3. 合并会话：文字编辑这类「一个字一次提交」的场景，整段只形成一条。
//  4. 代理：实时板把栈交给 `Y.UndoManager`，本地栈停用。
import type { EntityId } from "../types";
import {
  composePatch,
  invertPatch,
  isEmptyPatch,
  type EntityState,
  type Patch,
} from "./patch";

/** 栈深。超过就丢最旧的一条。 */
export const HISTORY_LIMIT = 200;

export interface HistoryEntry<D = unknown> {
  label: string;
  before: ReadonlyMap<EntityId, EntityState<D>>;
  after: ReadonlyMap<EntityId, EntityState<D>>;
}

/** 栈归外部时的代理（实时板的 `Y.UndoManager`）。 */
export interface HistoryDelegate {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  beginCoalesce(): void;
  endCoalesce(): void;
  /**
   * 执行 `remove`；若被删的实体刚建出来、栈顶正好只是它的「新建」，连同删除
   * 产生的那一步一起抹掉，返回 `true`；否则删除照常入栈、返回 `false`。
   */
  removeForgettingCreation(id: EntityId, remove: () => void): boolean;
  /** 栈变了就调 `notify`。返回退订。 */
  subscribe(notify: () => void): () => void;
}

export interface HistoryOptions<D> {
  limit?: number;
  /**
   * 回放：把 `patch.after` 写回场景。`patch` 是要应用的那一方向
   * （撤销时是 `{ before: 记录的 after, after: 记录的 before }`）。
   * 回放期间 `record` 被忽略，撤销自己不会进栈。
   */
  replay(patch: Patch<D>, direction: "undo" | "redo"): void;
}

export interface History<D = unknown> {
  /** 记一条；合并会话开着时并进当前会话。任何新记录都清空重做栈。 */
  record(entry: HistoryEntry<D>): void;
  beginCoalesce(label: string): void;
  endCoalesce(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  isReplaying(): boolean;
  /** 栈顶是不是「只新建了 `id` 这一个实体」。 */
  isCreationOnTop(id: EntityId): boolean;
  /** 弹掉「刚建出来、又被丢弃」的新建记录；栈顶不是它就返回 `false`。 */
  forgetCreation(id: EntityId): boolean;
  /** 把 `id` 写入内容之后的样子并进栈顶的「新建」记录；栈顶不是它返回 `false`。 */
  amendCreation(id: EntityId, entity: EntityState<D>): boolean;
  /** 实时板版的 `forgetCreation`：没有代理时什么也不做并返回 `null`。 */
  removeForgettingCreation(id: EntityId, remove: () => void): boolean | null;
  /** 装上 / 卸下代理；装上时清掉本地栈，两套栈不能混着撤。 */
  setDelegate(delegate: HistoryDelegate | null): void;
  /** 换板时清栈。 */
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createHistory<D = unknown>(
  options: HistoryOptions<D>,
): History<D> {
  const limit = options.limit ?? HISTORY_LIMIT;
  let past: HistoryEntry<D>[] = [];
  let future: HistoryEntry<D>[] = [];
  let coalescing: HistoryEntry<D> | null = null;
  let replaying = false;
  let delegate: HistoryDelegate | null = null;
  let offDelegate: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const entryPatch = (entry: HistoryEntry<D>): Patch<D> => entry;

  const push = (entry: HistoryEntry<D>): void => {
    past.push(entry);
    if (past.length > limit) past.shift();
    future = [];
    notify();
  };

  /** 栈顶正好是「只新建了 `id`」的记录就返回它。代理与合并会话期间一律 `null`。 */
  function creationOnTop(id: EntityId): HistoryEntry<D> | null {
    if (delegate || coalescing) return null;
    const last = past[past.length - 1];
    if (
      !last ||
      last.before.size !== 1 ||
      last.after.size !== 1 ||
      last.before.get(id) !== null ||
      last.after.get(id) == null
    ) {
      return null;
    }
    return last;
  }

  function run(patch: Patch<D>, direction: "undo" | "redo"): void {
    replaying = true;
    try {
      options.replay(patch, direction);
    } finally {
      replaying = false;
    }
  }

  const history: History<D> = {
    record(entry) {
      if (replaying || delegate) return;
      const patch = entryPatch(entry);
      if (isEmptyPatch(patch)) return;
      // 复制一份：记录之后调用方再改它的 Map 不该动到栈里的。
      const copy: HistoryEntry<D> = {
        label: entry.label,
        before: new Map(entry.before),
        after: new Map(entry.after),
      };
      if (coalescing) {
        const merged = composePatch(coalescing, copy);
        coalescing = { label: coalescing.label, ...merged };
        return;
      }
      push(copy);
    },
    beginCoalesce(label) {
      if (delegate) {
        delegate.beginCoalesce();
        return;
      }
      if (coalescing) history.endCoalesce();
      coalescing = { label, before: new Map(), after: new Map() };
    },
    endCoalesce() {
      if (delegate) {
        delegate.endCoalesce();
        return;
      }
      const session = coalescing;
      coalescing = null;
      if (!session || isEmptyPatch(session)) return;
      push(session);
    },
    undo() {
      if (delegate) {
        delegate.undo();
        return;
      }
      history.endCoalesce();
      const entry = past.pop();
      if (!entry) return;
      run(invertPatch(entry), "undo");
      future.push(entry);
      notify();
    },
    redo() {
      if (delegate) {
        delegate.redo();
        return;
      }
      const entry = future.pop();
      if (!entry) return;
      run(entry, "redo");
      past.push(entry);
      notify();
    },
    canUndo: () =>
      delegate ? delegate.canUndo() : past.length > 0 || coalescing !== null,
    canRedo: () => (delegate ? delegate.canRedo() : future.length > 0),
    isReplaying: () => replaying,
    isCreationOnTop: (id) => creationOnTop(id) !== null,
    forgetCreation(id) {
      if (!creationOnTop(id)) return false;
      past.pop();
      notify();
      return true;
    },
    amendCreation(id, entity) {
      const entry = creationOnTop(id);
      if (!entry) return false;
      (entry.after as Map<EntityId, EntityState<D>>).set(id, entity);
      notify();
      return true;
    },
    removeForgettingCreation: (id, remove) =>
      delegate ? delegate.removeForgettingCreation(id, remove) : null,
    setDelegate(next) {
      offDelegate?.();
      offDelegate = null;
      delegate = next;
      coalescing = null;
      past = [];
      future = [];
      if (next) offDelegate = next.subscribe(notify);
      notify();
    },
    reset() {
      coalescing = null;
      if (past.length === 0 && future.length === 0) return;
      past = [];
      future = [];
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return history;
}
