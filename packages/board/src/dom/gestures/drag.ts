// 拖动实体：阈值、多选一起走、网格吸附、边缘自动平移、拖入 / 拖出分组。
// 过程写 scene 预览；结束先发 move，再 clearPreview——应用要在 move 监听里同步把
// 位置写回真实数据，否则预览一清，实体会闪回原位一帧。
import { vecDist, type Entity, type EntityId, type Vec } from "../../core";
import { browserClock } from "../camera";
import type { Gesture, PointerInput } from "../types";
import {
  nextSelection,
  optionsOf,
  snap,
  topLevel,
  within,
  type GestureCtx,
} from "./types";

const EDGE = 32;
const EDGE_SPEED = 16;

export function createDrag(
  ctx: GestureCtx,
  first: PointerInput,
  id: EntityId,
  movable = true,
): Gesture {
  const { board, deps } = ctx;
  const { scene, camera } = board;
  const o = optionsOf(ctx);
  const clock = deps.clock ?? browserClock;
  const shift = first.mods.shift;
  const selected = board.selection().has(id);
  const picked = selected
    ? [...board.selection()]
    : shift
      ? [...board.selection(), id]
      : [id];
  const ids = movable
    ? topLevel(scene, picked).filter((i) => !scene.get(i)?.ends)
    : [];
  const start = new Map(ids.map((i) => [i, scene.get(i)!]));
  const abs = new Map(ids.map((i) => [i, scene.bounds(i)!]));
  const lead = abs.get(id) ?? abs.values().next().value;
  const isContainer = deps.isContainer ?? ((e: Entity) => e.kind === "group");

  let started = false;
  let last = first;
  let timer: { h: unknown } | null = null;
  let delta: Vec = { x: 0, y: 0 };
  let target: EntityId | null = null;

  const containerAt = (p: Vec): EntityId | null => {
    const depth = (e: Entity) => {
      let n = 0;
      for (let at = e.parent; at; at = scene.get(at)?.parent) n++;
      return n;
    };
    const under = scene.query(
      { x: p.x, y: p.y, w: 0, h: 0 },
      (e) => isContainer(e) && !ids.some((m) => within(scene, e.id, m)),
    );
    under.sort((a, b) => depth(a) - depth(b) || a.z - b.z);
    return under.at(-1)?.id ?? null;
  };

  const apply = (input: PointerInput) => {
    last = input;
    let dx = input.world.x - first.world.x;
    let dy = input.world.y - first.world.y;
    if (lead && o.grid > 0) {
      dx = snap(lead.x + dx, o.grid) - lead.x;
      dy = snap(lead.y + dy, o.grid) - lead.y;
    }
    delta = { x: dx, y: dy };
    target = containerAt(input.world);
    scene.preview(
      new Map(
        ids.map((i) => [
          i,
          { x: start.get(i)!.x + dx, y: start.get(i)!.y + dy },
        ]),
      ),
    );
  };

  const edgeVelocity = (): Vec | null => {
    if (!o.autoPan || camera.locked) return null;
    const v = camera.visible();
    const w = v.w * camera.get().zoom;
    const h = v.h * camera.get().zoom;
    const axis = (p: number, size: number) =>
      p < EDGE
        ? Math.min(1, (EDGE - p) / EDGE) * EDGE_SPEED
        : p > size - EDGE
          ? -Math.min(1, (p - (size - EDGE)) / EDGE) * EDGE_SPEED
          : 0;
    const x = axis(last.screen.x, w);
    const y = axis(last.screen.y, h);
    return x || y ? { x, y } : null;
  };
  const tick = () => {
    timer = null;
    const v = edgeVelocity();
    if (!started || !v) return;
    camera.panBy(v.x, v.y);
    apply({ ...last, world: camera.screenToWorld(last.screen) });
    timer = { h: clock.request(tick) };
  };

  const stop = () => {
    if (timer) clock.cancel(timer.h);
    timer = null;
  };
  const click = () =>
    board.emit("select", {
      ids: nextSelection(board.selection(), [id], shift),
      additive: shift,
    });

  return {
    name: "drag",
    move(input) {
      if (!started) {
        if (
          ids.length === 0 ||
          vecDist(input.screen, first.screen) < o.dragThreshold
        )
          return;
        started = true;
        if (!selected) board.emit("select", { ids: picked, additive: shift });
      }
      apply(input);
      if (!timer && edgeVelocity()) timer = { h: clock.request(tick) };
    },
    end(input) {
      stop();
      if (!started) return click();
      apply(input);
      const positions = new Map<EntityId, Vec>();
      const reparent = new Map<EntityId, EntityId | null>();
      const origin = target ? scene.bounds(target) : undefined;
      for (const i of ids) {
        const from = start.get(i)!;
        const next = (from.parent ?? null) === target ? undefined : target;
        if (next !== undefined) reparent.set(i, next);
        const b = abs.get(i)!;
        positions.set(
          i,
          next === undefined
            ? { x: from.x + delta.x, y: from.y + delta.y }
            : {
                x: b.x + delta.x - (origin?.x ?? 0),
                y: b.y + delta.y - (origin?.y ?? 0),
              },
        );
      }
      board.emit("move", { ids, positions, reparent });
      scene.clearPreview(ids);
    },
    cancel() {
      stop();
      scene.clearPreview(ids);
    },
  };
}
