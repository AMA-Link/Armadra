import { describe, expect, it } from "vitest";
import type { Entity, KindSpec, Rect } from "./index";

describe("core 公共类型", () => {
  it("实体与种类表的签名可以被构造", () => {
    const box: Rect = { x: 0, y: 0, w: 10, h: 10 };
    const entity: Entity<{ title: string }> = {
      id: "a",
      kind: "card",
      ...box,
      z: 0,
      data: { title: "t" },
    };
    const spec: KindSpec<{ title: string }> = {
      layer: "world",
      obstacle: true,
      resize: { min: { w: 8, h: 8 } },
    };
    expect(entity.data.title).toBe("t");
    expect(spec.layer).toBe("world");
  });
});
