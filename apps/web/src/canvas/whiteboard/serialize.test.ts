import { describe, expect, it } from "vitest";
import { MAX_WHITEBOARD_BYTES } from "@armadra/shared";

import {
  emptyWhiteboard,
  WHITEBOARD_ENGINE,
  WHITEBOARD_VERSION,
  type WhiteboardDoc,
} from "./model";
import { parseWhiteboard, serializeWhiteboard } from "./serialize";

/**
 * `whiteboard_json` 的读写（React Flow 计划 T04）。
 *
 * 只认 v3：其它一切按空白板处理，下一次保存直接覆盖（§3.2，用户决定不迁移
 * 旧数据）。这一条是数据安全的边界，所以正反两面都钉住。
 */

function doc(patch: Partial<WhiteboardDoc> = {}): WhiteboardDoc {
  return {
    ...emptyWhiteboard(),
    items: [
      {
        id: "3f",
        kind: "ink",
        x: 120,
        y: 80,
        w: 210,
        h: 96,
        z: 3,
        style: { color: "black", size: "m" },
        origin: { w: 210, h: 96 },
        points: [
          [0, 0, 0.5],
          [3.2, 1.1, 1],
        ],
      },
      {
        id: "4a",
        kind: "shape",
        x: 0,
        y: 0,
        w: 160,
        h: 120,
        z: 5,
        style: { color: "blue", size: "m", fill: "semi" },
        geo: "rectangle",
        label: "",
      },
    ],
    references: [{ id: "ref-1", itemId: "wb:3f", nodeId: "node-1" }],
    ...patch,
  };
}

describe("serializeWhiteboard ↔ parseWhiteboard", () => {
  it("往返恒等：对象、引用与样式一个字段不掉", () => {
    const source = doc();
    const parsed = parseWhiteboard(serializeWhiteboard(source));
    expect(parsed.recognised).toBe(true);
    expect(parsed.doc).toEqual(source);
  });

  it("空白板也往返恒等", () => {
    const parsed = parseWhiteboard(serializeWhiteboard(emptyWhiteboard()));
    expect(parsed.doc).toEqual(emptyWhiteboard());
  });

  it("序列化的头两个字段就是引擎与版本（打包壳的验收按它断言）", () => {
    expect(serializeWhiteboard(emptyWhiteboard())).toMatch(
      /^\{"engine":"armadra-board","version":3/u,
    );
  });

  it("v3 线上格式：短键、墨迹点集压成串、缺省样式不写", () => {
    const wire = JSON.parse(serializeWhiteboard(doc())) as {
      items: Record<string, unknown>[];
    };
    const [ink, shape] = wire.items;
    expect(ink).toMatchObject({
      id: "3f",
      k: "ink",
      b: [120, 80, 210, 96],
      o: [210, 96],
    });
    expect(typeof ink!.pt).toBe("string");
    expect(ink).not.toHaveProperty("s");
    expect(shape).toMatchObject({
      k: "shape",
      g: "rectangle",
      s: { c: "blue", f: "semi" },
    });
  });

  it("坐标取整：存的是整数，读回的是整数", () => {
    const source = doc();
    source.items[1] = { ...source.items[1]!, x: 10.6, w: 99.4 } as never;
    const back = parseWhiteboard(serializeWhiteboard(source)).doc.items[1]!;
    expect(back).toMatchObject({ x: 11, w: 99 });
  });
});

describe("只认 v3", () => {
  const rejected: Record<string, string | null | undefined> = {
    空串: "",
    null: null,
    undefined: undefined,
    不是JSON: "{oops",
    "JSON 但不是对象": "42",
    旧引擎的快照: JSON.stringify({
      store: { "shape:x": { typeName: "shape", type: "draw" } },
      schema: { schemaVersion: 2 },
    }),
    "上一代 v2 白板": JSON.stringify({
      engine: "armadra-flow",
      version: 2,
      items: [],
      references: [],
    }),
    引擎名对不上: JSON.stringify({
      engine: "somebody-else",
      version: WHITEBOARD_VERSION,
      items: [],
      references: [],
    }),
    更高的版本: JSON.stringify({
      engine: WHITEBOARD_ENGINE,
      version: 4,
      items: [],
      references: [],
    }),
    对象缺字段: JSON.stringify({
      engine: WHITEBOARD_ENGINE,
      version: WHITEBOARD_VERSION,
      items: [{ id: "x", k: "text" }],
      references: [],
    }),
    未知的对象类型: JSON.stringify({
      engine: WHITEBOARD_ENGINE,
      version: WHITEBOARD_VERSION,
      items: [{ id: "x", k: "cloud", b: [0, 0, 1, 1], z: 0 }],
      references: [],
    }),
  };

  for (const [name, text] of Object.entries(rejected)) {
    it(`${name} → 空白板，且标记为没认出来`, () => {
      const parsed = parseWhiteboard(text);
      expect(parsed.recognised).toBe(false);
      expect(parsed.doc).toEqual(emptyWhiteboard());
    });
  }
});

describe("8 MiB 上限", () => {
  it("空白板远小于上限", () => {
    expect(serializeWhiteboard(emptyWhiteboard()).length).toBeLessThan(200);
  });

  it("一条超长文字就能撑破上限：调用方靠长度判断，不靠 try/catch", () => {
    const huge = {
      ...emptyWhiteboard(),
      items: [
        {
          id: "x",
          kind: "text" as const,
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: 0,
          style: { color: "black" as const, size: "m" as const },
          text: "x".repeat(MAX_WHITEBOARD_BYTES),
        },
      ],
    };
    expect(serializeWhiteboard(huge).length).toBeGreaterThan(
      MAX_WHITEBOARD_BYTES,
    );
  });
});
