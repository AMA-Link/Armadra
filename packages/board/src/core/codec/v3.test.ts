import { describe, expect, it } from "vitest";

import { COORD_ERROR, PRESSURE_ERROR } from "./ink-pack";
import { fromRefItemId, isItemId, newItemId, toRefItemId } from "./id";
import type { BoardDoc, Item } from "./types";
import { decodeDoc, decodeItem, emptyDoc, encodeDoc, encodeItem } from "./v3";

const base = { x: 120, y: 80, w: 200, h: 100, z: 1 };
const plain = { color: "black", size: "m" } as const;

const items: Item[] = [
  {
    id: "h3Kq9vZ2xLmA",
    kind: "ink",
    ...base,
    z: 4,
    style: { color: "blue", size: "l" },
    highlight: true,
    origin: { w: 310, h: 142 },
    points: [
      [1.5, 2.25, 0.5],
      [30.1, 40.9, 0.5],
      [100, 9, 0.5],
    ],
  },
  {
    id: "aaaaaaaaaaaa",
    kind: "text",
    ...base,
    parentId: "frame-uuid",
    style: { color: "red", size: "s", align: "middle" },
    text: "备注\n第二行",
  },
  {
    id: "bbbbbbbbbbbb",
    kind: "shape",
    ...base,
    style: { color: "black", size: "m", fill: "semi", dash: "dashed" },
    geo: "diamond",
    label: "判断",
    meta: {
      source: { nodeId: "n1", sessionId: "s1", messageId: "m1" },
    },
  },
  { id: "cccccccccccc", kind: "shape", ...base, style: plain, geo: "ellipse" },
  {
    id: "dddddddddddd",
    kind: "image",
    ...base,
    style: plain,
    assetPath: ".armadra/assets/ab12.png",
    alt: "图",
  },
  {
    id: "eeeeeeeeeeee",
    kind: "line",
    ...base,
    style: plain,
    points: [
      [0, 0],
      [100, 20],
      [200, 120],
    ],
    arrowStart: true,
    arrowEnd: true,
  },
];

const doc: BoardDoc = {
  ...emptyDoc(),
  items,
  references: [{ id: "u-1", itemId: "wb:h3Kq9vZ2xLmA", nodeId: "u-2" }],
};

function decodeOk(text: string): BoardDoc {
  const r = decodeDoc(text);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("v3 编解码", () => {
  it("整份文档往返（墨迹点按量化误差比较）", () => {
    const back = decodeOk(encodeDoc(doc));
    expect(back.items).toHaveLength(items.length);
    back.items.forEach((item, i) => {
      const src = items[i]!;
      if (src.kind === "ink" && item.kind === "ink") {
        expect({ ...item, points: [] }).toEqual({ ...src, points: [] });
        src.points.forEach((p, j) => {
          expect(Math.abs(item.points[j]![0] - p[0])).toBeLessThanOrEqual(
            COORD_ERROR,
          );
          expect(Math.abs(item.points[j]![1] - p[1])).toBeLessThanOrEqual(
            COORD_ERROR,
          );
          expect(Math.abs(item.points[j]![2] - p[2])).toBeLessThanOrEqual(
            PRESSURE_ERROR,
          );
        });
      } else {
        expect(item).toEqual(src);
      }
    });
    expect(back.references).toEqual(doc.references);
  });

  it("单条往返，再编码字节不变", () => {
    for (const item of items) {
      const text = encodeItem(item);
      const r = decodeItem(text);
      expect(r.ok).toBe(true);
      if (r.ok) expect(encodeItem(r.value)).toBe(text);
    }
  });

  it("缺省样式不写，短键，b 与 ln 取整", () => {
    const wire = JSON.parse(
      encodeItem({
        id: "xxxxxxxxxxxx",
        kind: "line",
        x: 1.4,
        y: 1.6,
        w: 10.5,
        h: -3,
        z: 2,
        style: { color: "black", size: "m", dash: "solid", fill: "none" },
        points: [
          [0.4, 0.6],
          [9.5, 9.4],
        ],
      }),
    );
    expect(wire).toEqual({
      id: "xxxxxxxxxxxx",
      k: "line",
      b: [1, 2, 11, 0],
      z: 2,
      ln: [0, 1, 10, 9],
    });
  });

  it("非缺省样式写短键", () => {
    const wire = JSON.parse(encodeItem(items[2]!));
    expect(wire.s).toEqual({ d: "dashed", f: "semi" });
    expect(JSON.parse(encodeItem(items[0]!)).s).toEqual({ c: "blue", sz: "l" });
  });

  it("外壳固定为 armadra-board v3", () => {
    const wire = JSON.parse(encodeDoc(emptyDoc()));
    expect(wire).toEqual({
      engine: "armadra-board",
      version: 3,
      items: [],
      references: [],
    });
  });

  it("旧版与坏数据返回错误而不抛", () => {
    const bad = [
      "",
      "{",
      "null",
      "[]",
      '{"engine":"armadra-flow","version":2,"items":[],"references":[]}',
      '{"engine":"armadra-board","version":4,"items":[],"references":[]}',
      '{"engine":"armadra-board","version":3,"items":{},"references":[]}',
      '{"engine":"armadra-board","version":3,"items":[{"id":"a"}],"references":[]}',
      '{"engine":"armadra-board","version":3,"items":[],"references":[{"id":"a"}]}',
    ];
    for (const text of bad) expect(decodeDoc(text).ok).toBe(false);
  });

  it("单条的各类非法字段", () => {
    const ok = JSON.parse(encodeItem(items[3]!));
    const mutate = (patch: Record<string, unknown>) =>
      decodeItem(JSON.stringify({ ...ok, ...patch })).ok;
    expect(mutate({})).toBe(true);
    expect(mutate({ k: "blob" })).toBe(false);
    expect(mutate({ b: [1, 2, 3] })).toBe(false);
    expect(mutate({ b: [1, 2, -3, 4] })).toBe(false);
    expect(mutate({ b: [1, 2, "3", 4] })).toBe(false);
    expect(mutate({ z: "1" })).toBe(false);
    expect(mutate({ g: "pentagon" })).toBe(false);
    expect(mutate({ s: { c: "pink" } })).toBe(false);
    expect(mutate({ s: { d: "wavy" } })).toBe(false);
    expect(mutate({ p: "" })).toBe(false);
    expect(mutate({ m: { source: { nodeId: 1, sessionId: "s" } } })).toBe(
      false,
    );
    expect(decodeItem(JSON.stringify({ ...ok, k: "ink" })).ok).toBe(false);
    expect(decodeItem(JSON.stringify({ ...ok, k: "ink", pt: "***" })).ok).toBe(
      false,
    );
    expect(
      decodeItem(JSON.stringify({ ...ok, k: "line", ln: [1, 2, 3] })).ok,
    ).toBe(false);
  });

  it("对象 id 重复判整份失败", () => {
    const one = JSON.parse(encodeItem(items[3]!));
    const text = JSON.stringify({
      engine: "armadra-board",
      version: 3,
      items: [one, one],
      references: [],
    });
    expect(decodeDoc(text).ok).toBe(false);
  });

  it("多余键被忽略，不进入内存对象", () => {
    const wire = { ...JSON.parse(encodeItem(items[3]!)), extra: 1 };
    const r = decodeItem(JSON.stringify(wire));
    expect(r.ok && "extra" in r.value).toBe(false);
  });
});

describe("短 id", () => {
  function seeded(): (b: Uint8Array) => void {
    let s = 12345;
    return (b) => {
      for (let i = 0; i < b.length; i++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        b[i] = s >>> 24;
      }
    };
  }

  it("12 位 base62，同一随机源可复现，不同输出不同", () => {
    const fill = seeded();
    const ids = Array.from({ length: 500 }, () => newItemId(fill));
    for (const id of ids) {
      expect(id).toMatch(/^[0-9A-Za-z]{12}$/);
      expect(isItemId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(500);
    expect(newItemId(seeded())).toBe(newItemId(seeded()));
  });

  it("拒绝采样：字节 ≥ 248 被丢弃", () => {
    let call = 0;
    const id = newItemId((b) => {
      b.fill(call++ === 0 ? 255 : 1);
    });
    expect(id).toBe("1".repeat(12));
  });

  it("引用里的 wb: 前缀互转", () => {
    expect(toRefItemId("abc")).toBe("wb:abc");
    expect(toRefItemId("wb:abc")).toBe("wb:abc");
    expect(fromRefItemId("wb:abc")).toBe("abc");
    expect(fromRefItemId("abc")).toBe("abc");
  });
});
