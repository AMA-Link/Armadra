import { describe, expect, it } from "vitest";

import type { Entity, EntityId } from "../types";
import {
  HISTORY_LIMIT,
  createHistory,
  type HistoryDelegate,
  type History,
} from "./history";
import type { EntityState } from "./patch";

/**
 * 撤销语义（原 `store/canvas-store.test.ts` 的「撤销 / 重做」与 `realtime/undo.test.ts`
 * 里与库无关的用例，改写成针对 core 的版本）。world 是一张朴素的实体表，
 * 模拟 store：本地编辑 = 改 world 再 record，远端灌入 = 改 world 不 record。
 */

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "card",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  z: 0,
  data: "",
  ...patch,
});

function harness() {
  const world = new Map<EntityId, Entity>();
  const replayed: EntityId[][] = [];
  const history: History = createHistory({
    replay(patch) {
      replayed.push([...patch.after.keys()]);
      for (const [id, entity] of patch.after) {
        if (entity) world.set(id, entity);
        else world.delete(id);
      }
    },
  });
  /** 本地编辑：写 world 并记一条。 */
  const edit = (label: string, ...next: Entity[]) => {
    const before = new Map<EntityId, EntityState<unknown>>();
    const after = new Map<EntityId, EntityState<unknown>>();
    for (const entity of next) {
      const id = entity.id;
      before.set(id, world.get(id) ?? null);
      after.set(id, entity);
      world.set(id, entity);
    }
    history.record({ label, before, after });
  };
  const drop = (label: string, id: EntityId) => {
    const before = new Map([[id, world.get(id) ?? null]]);
    world.delete(id);
    history.record({ label, before, after: new Map([[id, null]]) });
  };
  /** 远端灌入：只改 world，不进栈。 */
  const remote = {
    put: (entity: Entity) => world.set(entity.id, entity),
    del: (id: EntityId) => world.delete(id),
  };
  return { world, history, edit, drop, remote, replayed };
}

describe("一次动作一条历史", () => {
  it("新建 → 撤销 → 重做", () => {
    const { world, history, edit } = harness();
    edit("add", make("a"));
    history.undo();
    expect(world.has("a")).toBe(false);
    history.redo();
    expect(world.has("a")).toBe(true);
  });

  it("连着两次移动要按两下才回到原位", () => {
    const { world, history, edit } = harness();
    world.set("a", make("a"));
    edit("move", make("a", { x: 100 }));
    edit("move", make("a", { x: 200 }));
    history.undo();
    expect(world.get("a")?.x).toBe(100);
    history.undo();
    expect(world.get("a")?.x).toBe(0);
  });

  it("删除可以撤销，实体与它的连线一起回来", () => {
    const { world, history } = harness();
    const a = make("a");
    const b = make("b");
    const line = make("line", { kind: "line", ends: ["a", "b"] });
    for (const e of [a, b, line]) world.set(e.id, e);
    history.record({
      label: "remove",
      before: new Map<EntityId, EntityState<unknown>>([
        ["b", b],
        ["line", line],
      ]),
      after: new Map<EntityId, EntityState<unknown>>([
        ["b", null],
        ["line", null],
      ]),
    });
    world.delete("b");
    world.delete("line");
    history.undo();
    expect([...world.keys()].sort()).toEqual(["a", "b", "line"]);
  });

  it("新记录清空重做栈", () => {
    const { history, edit } = harness();
    edit("a", make("a"));
    history.undo();
    expect(history.canRedo()).toBe(true);
    edit("b", make("b"));
    expect(history.canRedo()).toBe(false);
  });

  it("空补丁不入栈；超过栈深丢最旧的", () => {
    const { history, edit } = harness();
    history.record({ label: "x", before: new Map(), after: new Map() });
    expect(history.canUndo()).toBe(false);
    for (let i = 0; i <= HISTORY_LIMIT; i++) edit("e", make(`e${i}`));
    let undone = 0;
    while (history.canUndo()) {
      history.undo();
      undone += 1;
    }
    expect(undone).toBe(HISTORY_LIMIT);
  });

  it("回放期间 record 被忽略：撤销自己不进栈", () => {
    const world = new Map<EntityId, Entity>();
    const history: History = createHistory({
      replay(patch) {
        for (const [id, entity] of patch.after) {
          if (entity) world.set(id, entity);
          else world.delete(id);
        }
        expect(history.isReplaying()).toBe(true);
        history.record({
          label: "self",
          before: patch.before,
          after: patch.after,
        });
      },
    });
    world.set("a", make("a"));
    history.record({
      label: "add",
      before: new Map([["a", null]]),
      after: new Map([["a", make("a")]]),
    });
    history.undo();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });
});

describe("远端改动", () => {
  it("远端灌入不进栈：栈空时撤销什么都不发生", () => {
    const { history, remote, replayed } = harness();
    remote.put(make("a"));
    expect(history.canUndo()).toBe(false);
    history.undo();
    expect(replayed).toEqual([]);
  });

  it("撤销不删远端在这期间新增的实体", () => {
    const { world, history, edit, remote } = harness();
    world.set("a", make("a"));
    edit("move", make("a", { x: 60 }));
    remote.put(make("remote"));
    history.undo();
    expect(world.get("a")?.x).toBe(0);
    expect(world.has("remote")).toBe(true);
  });

  it("被远端删掉的实体撤销时复活为本地新建", () => {
    const { world, history, edit, remote } = harness();
    world.set("a", make("a", { data: "sticky" }));
    edit("rename", make("a", { data: "改过" }));
    remote.del("a");
    history.undo();
    expect(world.get("a")?.data).toBe("sticky");
  });

  it("只回放 before 里的 id：远端改了别的实体不受撤销影响", () => {
    const { world, history, edit, remote } = harness();
    world.set("a", make("a"));
    world.set("b", make("b"));
    edit("move a", make("a", { x: 1 }));
    remote.put(make("b", { x: 700 }));
    history.undo();
    expect(world.get("b")?.x).toBe(700);
  });
});

describe("合并会话", () => {
  it("一段文字编辑只形成一条历史，撤销回到会话之前", () => {
    const { world, history, edit } = harness();
    world.set("a", make("a", { data: "sticky" }));
    history.beginCoalesce("edit text");
    edit("t", make("a", { data: "一" }));
    edit("t", make("a", { data: "一二" }));
    edit("t", make("a", { data: "一二三" }));
    history.endCoalesce();
    history.undo();
    expect(world.get("a")?.data).toBe("sticky");
    expect(history.canUndo()).toBe(false);
    history.redo();
    expect(world.get("a")?.data).toBe("一二三");
  });

  it("会话开着时可撤销（撤销先结束会话）；空会话不入栈", () => {
    const { world, history, edit } = harness();
    world.set("a", make("a", { data: "0" }));
    history.beginCoalesce("x");
    history.endCoalesce();
    expect(history.canUndo()).toBe(false);

    history.beginCoalesce("x");
    edit("t", make("a", { data: "1" }));
    expect(history.canUndo()).toBe(true);
    history.undo();
    expect(world.get("a")?.data).toBe("0");
  });

  it("会话里最早的 before 才是「改之前」，会话中途新建的实体撤销后消失", () => {
    const { world, history, edit } = harness();
    history.beginCoalesce("x");
    edit("t", make("n", { data: "1" }));
    edit("t", make("n", { data: "2" }));
    history.endCoalesce();
    history.undo();
    expect(world.has("n")).toBe(false);
  });

  it("新会话顶掉没结束的旧会话", () => {
    const { world, history, edit } = harness();
    world.set("a", make("a"));
    history.beginCoalesce("1");
    edit("t", make("a", { x: 1 }));
    history.beginCoalesce("2");
    edit("t", make("a", { x: 2 }));
    history.endCoalesce();
    history.undo();
    expect(world.get("a")?.x).toBe(1);
    history.undo();
    expect(world.get("a")?.x).toBe(0);
  });
});

describe("刚建即弃的对象（#733）", () => {
  it("栈顶是它的新建：forgetCreation 弹掉，⌘Z 撤的是上一步真实操作", () => {
    const { world, history, edit } = harness();
    world.set("a", make("a"));
    edit("move", make("a", { x: 50 }));
    edit("add text", make("t1"));
    expect(history.isCreationOnTop("t1")).toBe(true);
    expect(history.forgetCreation("t1")).toBe(true);
    world.delete("t1");

    history.undo();
    expect(world.get("a")?.x).toBe(0);
    expect(world.has("t1")).toBe(false);
    expect(history.canUndo()).toBe(false);
  });

  it("栈里什么都没有时 forgetCreation 返回 false", () => {
    const { history } = harness();
    expect(history.forgetCreation("t1")).toBe(false);
  });

  it("已有内容被清空：栈顶不是新建，仍是一步普通删除、撤销找得回来", () => {
    const { world, history, edit, drop } = harness();
    edit("add", make("t1", { data: "你好" }));
    edit("move", make("a", { x: 50 }));
    expect(history.forgetCreation("t1")).toBe(false);
    drop("remove", "t1");
    history.undo();
    expect(world.get("t1")?.data).toBe("你好");
  });

  it("栈顶不是这条的新建：不乱弹，删除照常可撤", () => {
    const { world, history, edit, drop } = harness();
    edit("add", make("t1"));
    edit("add", make("t2"));
    expect(history.forgetCreation("t1")).toBe(false);
    drop("remove", "t1");
    expect([...world.keys()]).toEqual(["t2"]);
    history.undo();
    expect([...world.keys()].sort()).toEqual(["t1", "t2"]);
  });

  it("amendCreation：第一次写内容并进新建，撤销一步整条对象消失", () => {
    const { world, history, edit } = harness();
    edit("add", make("t1"));
    const filled = make("t1", { data: "你好" });
    world.set("t1", filled);
    expect(history.amendCreation("t1", filled)).toBe(true);
    history.undo();
    expect(world.has("t1")).toBe(false);
    history.redo();
    expect(world.get("t1")).toBe(filled);
    expect(history.amendCreation("ghost", filled)).toBe(false);
  });

  it("合并会话期间不认栈顶", () => {
    const { history, edit } = harness();
    edit("add", make("t1"));
    history.beginCoalesce("x");
    expect(history.isCreationOnTop("t1")).toBe(false);
  });
});

describe("代理（实时板）", () => {
  function fakeDelegate() {
    const calls: string[] = [];
    const watchers = new Set<() => void>();
    const delegate: HistoryDelegate = {
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
      canUndo: () => true,
      canRedo: () => false,
      beginCoalesce: () => calls.push("begin"),
      endCoalesce: () => calls.push("end"),
      removeForgettingCreation: (_id, remove) => {
        remove();
        return true;
      },
      subscribe: (notify) => {
        watchers.add(notify);
        return () => watchers.delete(notify);
      },
    };
    return { delegate, calls, watchers };
  }

  it("装上之后本地栈停用，undo / 合并会话 / 可撤销都转给代理", () => {
    const { history, edit } = harness();
    const { delegate, calls } = fakeDelegate();
    history.setDelegate(delegate);
    edit("add", make("a"));
    history.beginCoalesce("x");
    history.endCoalesce();
    history.undo();
    history.redo();
    expect(calls).toEqual(["begin", "end", "undo", "redo"]);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(history.forgetCreation("a")).toBe(false);
  });

  it("装上时清掉本地栈，卸下之后恢复本地栈", () => {
    const { history, edit } = harness();
    edit("add", make("a"));
    const { delegate } = fakeDelegate();
    history.setDelegate(delegate);
    history.setDelegate(null);
    expect(history.canUndo()).toBe(false);
    edit("add", make("b"));
    expect(history.canUndo()).toBe(true);
  });

  it("代理栈变化会通知订阅方；removeForgettingCreation 没有代理时返回 null", () => {
    const { history } = harness();
    let notified = 0;
    history.subscribe(() => (notified += 1));
    expect(history.removeForgettingCreation("a", () => {})).toBeNull();
    const { delegate, watchers } = fakeDelegate();
    history.setDelegate(delegate);
    const before = notified;
    for (const notify of watchers) notify();
    expect(notified).toBe(before + 1);
    let removed = false;
    expect(history.removeForgettingCreation("a", () => (removed = true))).toBe(
      true,
    );
    expect(removed).toBe(true);
    history.setDelegate(null);
    expect(watchers.size).toBe(0);
  });
});

describe("reset 与订阅", () => {
  it("换板清栈并通知；本来就空则不通知", () => {
    const { history, edit } = harness();
    let notified = 0;
    history.subscribe(() => (notified += 1));
    history.reset();
    expect(notified).toBe(0);
    edit("add", make("a"));
    const after = notified;
    history.reset();
    expect(notified).toBe(after + 1);
    expect(history.canUndo()).toBe(false);
  });
});
