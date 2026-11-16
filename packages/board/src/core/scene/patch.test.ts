import { describe, expect, it } from "vitest";

import type { Entity } from "../types";
import {
  composePatch,
  diffEntities,
  emptyPatch,
  invertPatch,
  isEmptyPatch,
} from "./patch";

const make = (id: string, x = 0): Entity => ({
  id,
  kind: "card",
  x,
  y: 0,
  w: 10,
  h: 10,
  z: 0,
  data: null,
});

describe("diffEntities", () => {
  it("同一个数组引用：空补丁，连索引都不建", () => {
    const list = [make("a")];
    expect(isEmptyPatch(diffEntities(list, list))).toBe(true);
  });

  it("按身份比较：没动的不进补丁，改了的前后都记，新增的 before 为 null", () => {
    const a = make("a");
    const b = make("b");
    const b2 = { ...b, x: 5 };
    const c = make("c");
    const patch = diffEntities([a, b], [a, b2, c]);
    expect([...patch.before.keys()].sort()).toEqual(["b", "c"]);
    expect(patch.before.get("b")).toBe(b);
    expect(patch.after.get("b")).toBe(b2);
    expect(patch.before.get("c")).toBeNull();
    expect(patch.after.get("c")).toBe(c);
  });

  it("删除：after 记为 null", () => {
    const a = make("a");
    const patch = diffEntities([a], []);
    expect(patch.before.get("a")).toBe(a);
    expect(patch.after.get("a")).toBeNull();
  });
});

describe("composePatch", () => {
  it("最早的 before、最后的 after；没碰过的 id 各自保留", () => {
    const a0 = make("a", 0);
    const a1 = make("a", 1);
    const a2 = make("a", 2);
    const b = make("b");
    const merged = composePatch(
      { before: new Map([["a", a0]]), after: new Map([["a", a1]]) },
      {
        before: new Map<string, Entity | null>([
          ["a", a1],
          ["b", null],
        ]),
        after: new Map<string, Entity | null>([
          ["a", a2],
          ["b", b],
        ]),
      },
    );
    expect(merged.before.get("a")).toBe(a0);
    expect(merged.after.get("a")).toBe(a2);
    expect(merged.before.get("b")).toBeNull();
    expect(merged.after.get("b")).toBe(b);
  });

  it("净变化为零（建了又删）的 id 被丢掉", () => {
    const a = make("a");
    const merged = composePatch(
      { before: new Map([["a", null]]), after: new Map([["a", a]]) },
      { before: new Map([["a", a]]), after: new Map([["a", null]]) },
    );
    expect(isEmptyPatch(merged)).toBe(true);
  });
});

describe("invertPatch", () => {
  it("前后对调", () => {
    const a = make("a");
    const patch = {
      before: new Map([["a", null]]),
      after: new Map([["a", a]]),
    };
    const inverse = invertPatch(patch);
    expect(inverse.before).toBe(patch.after);
    expect(inverse.after).toBe(patch.before);
    expect(isEmptyPatch(emptyPatch())).toBe(true);
  });
});
