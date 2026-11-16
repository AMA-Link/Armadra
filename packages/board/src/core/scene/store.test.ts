import { describe, expect, it } from "vitest";

import type { Entity, EntityId, KindSpec } from "../types";
import { createScene, createSceneCore } from "./store";

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "card",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  z: 0,
  data: null,
  ...patch,
});

const put = (...entities: Entity[]) =>
  new Map<EntityId, Entity | null>(entities.map((e) => [e.id, e]));

const kinds: Record<string, Pick<KindSpec, "layer" | "hit">> = {
  card: { layer: "world" },
  ink: { layer: "canvas-over" },
  grid: { layer: "canvas-under" },
  round: {
    layer: "world",
    hit: (entity, point) =>
      Math.hypot(
        point.x - (entity.x + entity.w / 2),
        point.y - (entity.y + entity.h / 2),
      ) <=
      entity.w / 2,
  },
};

describe("实体表与对象身份", () => {
  it("写入后可读；没改动的实体保持同一个引用，不通知", () => {
    const core = createSceneCore();
    const a = make("a");
    const b = make("b");
    core.write(put(a, b));
    const seen: ReadonlySet<EntityId>[] = [];
    core.subscribe((changed) => seen.push(changed));

    core.write(put(a, { ...b, x: 9 }));
    expect(core.get("a")).toBe(a);
    expect(core.get("b")?.x).toBe(9);
    expect([...seen[0]!]).toEqual(["b"]);

    core.write(put(a));
    expect(seen).toHaveLength(1);
  });

  it("sync 应用补丁的 after：新建与删除都生效", () => {
    const scene = createScene();
    const a = make("a");
    scene.sync({ before: new Map(), after: put(a) });
    expect(scene.get("a")).toBe(a);
    scene.sync({ before: new Map(), after: new Map([["a", null]]) });
    expect(scene.has("a")).toBe(false);
    expect(scene.size).toBe(0);
  });

  it("批量通知：一次写多条只通知一次", () => {
    const core = createSceneCore();
    let calls = 0;
    core.subscribe(() => (calls += 1));
    core.write(put(make("a"), make("b"), make("c")));
    expect(calls).toBe(1);
  });

  it("退订之后不再通知", () => {
    const core = createSceneCore();
    let calls = 0;
    const off = core.subscribe(() => (calls += 1));
    off();
    core.write(put(make("a")));
    expect(calls).toBe(0);
  });
});

describe("父子与顺序", () => {
  it("children 按 z 升序；改父级后分组跟着变", () => {
    const core = createSceneCore();
    core.write(
      put(
        make("g"),
        make("c1", { parent: "g", z: 2 }),
        make("c2", { parent: "g", z: 1 }),
        make("top", { z: 5 }),
      ),
    );
    expect(core.children("g").map((e) => e.id)).toEqual(["c2", "c1"]);
    expect(core.children().map((e) => e.id)).toEqual(["g", "top"]);
    core.write(put(make("c2", { z: 1 })));
    expect(core.children("g").map((e) => e.id)).toEqual(["c1"]);
    expect(core.children().map((e) => e.id)).toContain("c2");
  });

  it("ordered 先按层再按 z，同 z 保持写入顺序；无变化时同一个数组", () => {
    const core = createSceneCore({ kinds: (kind) => kinds[kind] });
    core.write(
      put(
        make("w2", { z: 2 }),
        make("ink", { kind: "ink", z: 0 }),
        make("w1", { z: 1 }),
        make("grid", { kind: "grid", z: 9 }),
        make("w1b", { z: 1 }),
      ),
    );
    const list = core.ordered();
    expect(list.map((e) => e.id)).toEqual(["grid", "w1", "w1b", "w2", "ink"]);
    expect(core.ordered()).toBe(list);
    core.write(put(make("n")));
    expect(core.ordered()).not.toBe(list);
  });
});

describe("包围盒、查询与命中", () => {
  it("bounds 叠加父级偏移", () => {
    const core = createSceneCore();
    core.write(
      put(
        make("g", { x: 100, y: 100 }),
        make("c", { parent: "g", x: 10, y: 20, w: 30, h: 40 }),
      ),
    );
    expect(core.bounds("c")).toEqual({ x: 110, y: 120, w: 30, h: 40 });
    expect(core.bounds("ghost")).toBeUndefined();
  });

  it("父子成环不会死循环", () => {
    const core = createSceneCore();
    core.write(put(make("a", { parent: "b" }), make("b", { parent: "a" })));
    expect(core.bounds("a")).toBeDefined();
  });

  it("连接类实体取两端包围盒的并集；缺一端没有包围盒", () => {
    const core = createSceneCore();
    core.write(
      put(
        make("a", { x: 0, y: 0, w: 10, h: 10 }),
        make("b", { x: 100, y: 50, w: 10, h: 10 }),
        make("line", { kind: "line", ends: ["a", "b"] }),
        make("dangling", { kind: "line", ends: ["a", "nope"] }),
      ),
    );
    expect(core.bounds("line")).toEqual({ x: 0, y: 0, w: 110, h: 60 });
    expect(core.bounds("dangling")).toBeUndefined();
  });

  it("query 含相切，filter 可筛", () => {
    const core = createSceneCore();
    core.write(
      put(
        make("a", { x: 0, y: 0, w: 10, h: 10 }),
        make("b", { x: 10, y: 0, w: 10, h: 10, kind: "ink" }),
        make("far", { x: 500, y: 500 }),
      ),
    );
    const area = { x: 10, y: 0, w: 5, h: 5 };
    expect(core.query(area).map((e) => e.id)).toEqual(["a", "b"]);
    expect(core.query(area, (e) => e.kind === "ink").map((e) => e.id)).toEqual([
      "b",
    ]);
  });

  it("hit 取最上面的；容差、层过滤、精确命中规则都生效", () => {
    const core = createSceneCore({ kinds: (kind) => kinds[kind] });
    core.write(
      put(
        make("under", { z: 0 }),
        make("over", { z: 1, w: 20, h: 20 }),
        make("ink", { kind: "ink", w: 20, h: 20 }),
        make("round", { kind: "round", x: 300, y: 0, w: 40, h: 40 }),
      ),
    );
    expect(core.hit({ x: 5, y: 5 })?.id).toBe("ink");
    expect(core.hit({ x: 5, y: 5 }, { layers: ["world"] })?.id).toBe("over");
    expect(core.hit({ x: 50, y: 5 })?.id).toBe("under");
    expect(core.hit({ x: 103, y: 5 })).toBeUndefined();
    expect(core.hit({ x: 103, y: 5 }, { tolerance: 4 })?.id).toBe("under");
    // 圆形的包围盒角落在规则外
    expect(core.hit({ x: 301, y: 1 })).toBeUndefined();
    expect(core.hit({ x: 320, y: 20 })?.id).toBe("round");
  });
});

describe("预览事务", () => {
  it("预览只影响 bounds，不动文档；按 id 合并写，值没变不通知", () => {
    const core = createSceneCore();
    const a = make("a");
    core.write(put(a));
    const seen: ReadonlySet<EntityId>[] = [];
    core.subscribe((changed) => seen.push(changed));

    core.preview(new Map([["a", { x: 7 }]]));
    core.preview(new Map([["a", { y: 8 }]]));
    expect(core.get("a")).toBe(a);
    expect(core.bounds("a")).toEqual({ x: 7, y: 8, w: 100, h: 50 });
    expect(core.previewOf("a")).toEqual({ x: 7, y: 8 });
    expect(core.gestureActive()).toBe(true);
    expect(seen).toHaveLength(2);

    core.preview(new Map([["a", { x: 7, y: 8 }]]));
    expect(seen).toHaveLength(2);
  });

  it("多条一次预览只通知一次，通知里带随父级移动的子孙与相连的连线", () => {
    const core = createSceneCore();
    core.write(
      put(
        make("g"),
        make("c", { parent: "g" }),
        make("b"),
        make("line", { kind: "line", ends: ["c", "b"] }),
      ),
    );
    const seen: ReadonlySet<EntityId>[] = [];
    core.subscribe((changed) => seen.push(changed));
    core.preview(
      new Map([
        ["g", { x: 5 }],
        ["b", { x: 9 }],
      ]),
    );
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(["b", "c", "g", "line"]);
    expect(core.bounds("c")?.x).toBe(5);
  });

  it("clearPreview 可只清点名的，清不存在的不通知，清空后手势结束", () => {
    const core = createSceneCore();
    core.write(put(make("a"), make("b")));
    core.preview(
      new Map([
        ["a", { x: 1 }],
        ["b", { x: 2 }],
      ]),
    );
    let calls = 0;
    core.subscribe(() => (calls += 1));
    core.clearPreview(["ghost"]);
    expect(calls).toBe(0);
    core.clearPreview(["a"]);
    expect(core.previewOf("a")).toBeUndefined();
    expect(core.gestureActive()).toBe(true);
    core.clearPreview();
    expect(core.gestureActive()).toBe(false);
    expect(core.bounds("b")?.x).toBe(0);
  });
});
