// 板的 context 与读状态的 hook（设计 §2.8）。
import * as React from "react";
import type { CameraState, Entity, EntityId } from "../core";
import type { DomBoard } from "../dom";

const BoardContext = React.createContext<DomBoard | null>(null);

export const BoardProvider = BoardContext.Provider;

export function useBoard<D = unknown>(): DomBoard<D> {
  const board = React.useContext(BoardContext);
  if (!board) throw new Error("useBoard 必须在 <BoardView> 之内使用");
  return board as DomBoard<D>;
}

const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      Object.is(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    )
  );
};

/**
 * 订阅相机的一个切片：选择结果不变就不重渲（原始值或浅比较相等的对象）。
 * `select` 不必稳定——它在每次相机变化时才跑。
 */
export function useCamera<T>(select: (state: CameraState) => T): T {
  const { camera } = useBoard();
  const last = React.useRef<{ state: CameraState; value: T } | null>(null);
  const read = (): T => {
    const state = camera.get();
    const prev = last.current;
    if (prev?.state === state) return prev.value;
    const value = select(state);
    const keep = prev && shallowEqual(prev.value, value) ? prev.value : value;
    last.current = { state, value: keep };
    return keep;
  };
  return React.useSyncExternalStore(camera.subscribe, read, read);
}

/** 订阅一个实体：文档里的那个对象，未改动时身份不变；预览变化不触发。 */
export function useEntity<D = unknown>(id: EntityId): Entity<D> | undefined {
  const { scene } = useBoard<D>();
  const subscribe = React.useCallback(
    (notify: () => void) =>
      scene.subscribe((changed) => changed.has(id) && notify()),
    [scene, id],
  );
  const read = () => scene.get(id);
  return React.useSyncExternalStore(subscribe, read, read);
}

/** 这个实体是否在选区里。 */
export function useSelected(id: EntityId): boolean {
  const board = useBoard();
  const subscribe = React.useCallback(
    (notify: () => void) => board.on("selection", notify),
    [board],
  );
  const read = () => board.selection().has(id);
  return React.useSyncExternalStore(subscribe, read, read);
}

/** 有手势在进行（拖动、缩放、框选……）。 */
export function useGestureActive(): boolean {
  const board = useBoard();
  const subscribe = React.useCallback(
    (notify: () => void) => board.on("gesture", notify),
    [board],
  );
  const read = () => board.gestureActive();
  return React.useSyncExternalStore(subscribe, read, read);
}
