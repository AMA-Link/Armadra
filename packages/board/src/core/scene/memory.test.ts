import { describe, expect, it } from "vitest";

import type { Entity, EntityId } from "../types";
import { createMemoryScene } from "./memory";

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "card",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  z: 0,
  data: "",
  ...patch,
});

describe("transact", () => {
  it("一次事务一条历史：新建 → 撤销 → 重做，返回的补丁带前后", () => {
    const scene = createMemoryScene();
    const a = make("a");
    const patch = scene.transact((d) => d.set(a), { label: "add" });
    expect(patch.before.get("a")).toBeNull();
    expect(patch.after.get("a")).toBe(a);
    scene.undo();
    expect(scene.has("a")).toBe(false);
    scene.redo();
    expect(scene.get("a")).toBe(a);
  });

  it("草稿读到事务内最新值；update 浅合并，实体不存在返回 false；事务内新建又删除没有净变化", () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a")));
    const before = scene.get("a");
    let missing = true;
    const patch = scene.transact((d) => {
      d.update("a", { x: 5 });
      expect(d.get("a")?.x).toBe(5);
      expect(scene.get("a")).toBe(before);
      missing = d.update("ghost", { x: 1 });
      d.set(make("tmp"));
      d.remove("tmp");
    });
    expect(missing).toBe(false);
    expect(scene.get("a")?.x).toBe(5);
    expect(scene.get("a")?.w).toBe(100);
    expect([...patch.after.keys()].sort()).toEqual(["a"]);
  });

  it("mutate 抛错：什么都没写、没有历史", () => {
    const scene = createMemoryScene();
    expect(() =>
      scene.transact((d) => {
        d.set(make("a"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(scene.has("a")).toBe(false);
    expect(scene.canUndo()).toBe(false);
  });

  it("没有实际变化的事务不入栈、不通知", () => {
    const scene = createMemoryScene();
    const a = make("a");
    scene.transact((d) => d.set(a));
    let calls = 0;
    scene.subscribe(() => (calls += 1));
    scene.transact((d) => d.set(a));
    expect(calls).toBe(0);
    scene.undo();
    expect(scene.has("a")).toBe(false);
    expect(scene.canUndo()).toBe(false);
  });

  it('history: "ignore" 的远端合并照写但不入栈，⌘Z 撤不掉别人的改动', () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a")));
    scene.transact((d) => d.set(make("remote")), { history: "ignore" });
    scene.sync({ before: new Map(), after: new Map([["r2", make("r2")]]) });
    scene.undo();
    expect(scene.has("a")).toBe(false);
    expect(scene.has("remote")).toBe(true);
    expect(scene.has("r2")).toBe(true);
    expect(scene.canUndo()).toBe(false);
  });

  it("远端删除后本地撤销：复活为本地新建，不影响远端新增", () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a", { data: "sticky" })));
    scene.transact((d) => d.update("a", { data: "改过" }));
    scene.sync({ before: new Map(), after: new Map([["a", null]]) });
    scene.sync({ before: new Map(), after: new Map([["n", make("n")]]) });
    scene.undo();
    expect(scene.get("a")?.data).toBe("sticky");
    expect(scene.has("n")).toBe(true);
  });
});

describe("apply", () => {
  it("返回逆补丁；前值取实际当前值而不是补丁里的 before", () => {
    const scene = createMemoryScene();
    const a1 = make("a", { x: 1 });
    scene.transact((d) => d.set(a1));
    const a2 = make("a", { x: 2 });
    const inverse = scene.apply({
      before: new Map([["a", make("a", { x: 999 })]]),
      after: new Map([["a", a2]]),
    });
    expect(scene.get("a")).toBe(a2);
    expect(inverse.after.get("a")).toBe(a1);
    expect(inverse.before.get("a")).toBe(a2);
    scene.apply(inverse, { history: "ignore" });
    expect(scene.get("a")).toBe(a1);
  });
});

describe("预览事务的提交与丢弃", () => {
  it("预览期间文档不变；commitPreview 一次手势一条历史", () => {
    const scene = createMemoryScene();
    scene.transact((d) => {
      d.set(make("a"));
      d.set(make("b", { x: 50 }));
    });
    for (let i = 1; i <= 5; i++) {
      scene.preview(
        new Map([
          ["a", { x: i * 10 }],
          ["b", { x: 50 + i * 10 }],
        ]),
      );
    }
    expect(scene.get("a")?.x).toBe(0);
    expect(scene.gestureActive()).toBe(true);

    const seen: ReadonlySet<EntityId>[] = [];
    scene.subscribe((changed) => seen.push(changed));
    const patch = scene.commitPreview({ label: "move" });
    expect(seen).toHaveLength(1);
    expect(scene.gestureActive()).toBe(false);
    expect(scene.get("a")?.x).toBe(50);
    expect(scene.get("b")?.x).toBe(100);
    expect([...patch.after.keys()].sort()).toEqual(["a", "b"]);

    scene.undo();
    expect(scene.get("a")?.x).toBe(0);
    expect(scene.get("b")?.x).toBe(50);
    expect(scene.canUndo()).toBe(true);
    scene.undo();
    expect(scene.canUndo()).toBe(false);
  });

  it("丢弃：文档与历史都没动；预览指向已不存在的实体时提交跳过它", () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a")));
    scene.preview(new Map([["a", { x: 9 }]]));
    scene.clearPreview();
    expect(scene.bounds("a")?.x).toBe(0);
    scene.undo();
    expect(scene.canUndo()).toBe(false);

    scene.transact((d) => d.set(make("a")));
    scene.preview(
      new Map([
        ["a", { x: 9 }],
        ["gone", { x: 1 }],
      ]),
    );
    expect([...scene.commitPreview().after.keys()]).toEqual(["a"]);
  });

  it("提交可选 ignore：不入栈", () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a")), { history: "ignore" });
    scene.preview(new Map([["a", { w: 7 }]]));
    scene.commitPreview({ history: "ignore" });
    expect(scene.get("a")?.w).toBe(7);
    expect(scene.canUndo()).toBe(false);
  });
});

describe("合并会话", () => {
  it("一段文字编辑只形成一条历史；历史订阅在入栈与撤销时通知", () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a", { data: "sticky" })), {
      history: "ignore",
    });
    let notified = 0;
    scene.subscribeHistory(() => (notified += 1));
    scene.beginCoalesce("edit text");
    for (const text of ["一", "一二", "一二三"]) {
      scene.transact((d) => d.update("a", { data: text }));
    }
    expect(notified).toBe(0);
    scene.endCoalesce();
    expect(notified).toBe(1);
    scene.undo();
    expect(scene.get("a")?.data).toBe("sticky");
    expect(notified).toBe(2);
    scene.resetHistory();
    expect(scene.canRedo()).toBe(false);
  });
});
