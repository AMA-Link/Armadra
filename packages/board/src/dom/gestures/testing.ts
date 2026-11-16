// 手势测试的替身 Board：真相机 + 真内存场景，事件与选择记在数组里。
import type { Entity, EntityId, Vec } from "../../core";
import { createMemoryScene } from "../../core";
import { createCamera } from "../camera";
import type { Board, BoardEvents, Modifiers, PointerInput } from "../types";

export const NO_MODS: Modifiers = {
  shift: false,
  alt: false,
  meta: false,
  ctrl: false,
  space: false,
};

export function makeBoard(entities: Entity[] = []) {
  const scene = createMemoryScene();
  scene.transact((draft) => entities.forEach((e) => draft.set(e)), {
    history: "ignore",
  });
  const camera = createCamera();
  camera.setViewport({ width: 800, height: 600 });
  const events: { event: keyof BoardEvents; payload: unknown }[] = [];
  let selection: ReadonlySet<EntityId> = new Set();
  const board = {
    camera,
    scene,
    emit: (event: keyof BoardEvents, payload: unknown) =>
      void events.push({ event, payload }),
    selection: () => selection,
    setSelection: (ids: ReadonlySet<EntityId>) => void (selection = ids),
  } as unknown as Board;
  return {
    board,
    scene,
    camera,
    events,
    of: (name: keyof BoardEvents) =>
      events.filter((e) => e.event === name).map((e) => e.payload),
  };
}

export const box = (
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
  extra: Partial<Entity> = {},
): Entity => ({ id, kind: "card", x, y, w, h, z: 0, data: null, ...extra });

/** 合成一个指针输入（屏幕坐标 = 世界坐标，除非另给）。 */
export function pointer(
  at: Vec,
  extra: Partial<PointerInput> = {},
): PointerInput {
  return {
    id: 1,
    type: "mouse",
    button: 0,
    screen: at,
    world: at,
    pressure: 0.5,
    mods: NO_MODS,
    target: { type: "blank" },
    time: 0,
    ...extra,
  };
}
