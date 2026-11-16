// 体积基准（docs/design/board-engine.md §3.2 末尾）。样本与基线报告
// （docs/armadra/reports/board-baseline-2026-11-15.md，种子 952）同一个生成器：
// 300 条 × 40 点墨迹、1 条 1,000 点长线、1 个缺省样式矩形。
// v2 按两种口径量：原始浮点，和保留 2 位小数。

import { describe, expect, it } from "vitest";

import { newItemId } from "./id";
import type { BoardDoc, InkItem, Item } from "./types";
import { emptyDoc, encodeDoc, encodeItem } from "./v3";

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sample {
  v3: BoardDoc;
  /** 同一内容的 v2 文本，字段与 `apps/web/.../whiteboard/model.ts` 一致。 */
  v2: string;
  v2Round2: string;
}

const hex = (rnd: () => number, n: number): string =>
  Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
const uuid = (rnd: () => number): string =>
  `${hex(rnd, 8)}-${hex(rnd, 4)}-4${hex(rnd, 3)}-a${hex(rnd, 3)}-${hex(rnd, 12)}`;

function makeSamples(): Record<"ink300x40" | "ink1x1000" | "shape", Sample> {
  const rnd = mulberry32(952);
  const style = { color: "black", size: "m" } as const;
  const fill = (b: Uint8Array) => {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256);
  };

  const ink = (n: number, z: number): { v3: InkItem; v2: object } => {
    let x = rnd() * 40;
    let y = rnd() * 40;
    let a = rnd() * Math.PI * 2;
    const points: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      a += (rnd() - 0.5) * 0.6;
      x += Math.cos(a) * (1 + rnd() * 3);
      y += Math.sin(a) * (1 + rnd() * 3);
      points.push([x, y, 0.5]);
    }
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const geo = {
      x: rnd() * 4000,
      y: rnd() * 3000,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    return {
      v3: {
        id: newItemId(fill),
        kind: "ink",
        ...geo,
        z,
        style,
        points,
        origin: { w: Math.round(geo.w), h: Math.round(geo.h) },
      },
      v2: { id: `wb:${uuid(rnd)}`, kind: "ink", ...geo, z, style, points },
    };
  };

  const round2 = (text: string): string =>
    JSON.stringify(JSON.parse(text), (_k, v: unknown) =>
      typeof v === "number" ? Math.round(v * 100) / 100 : v,
    );
  const sample = (v3Items: Item[], v2Items: object[]): Sample => {
    const v2 = JSON.stringify({
      engine: "armadra-flow",
      version: 2,
      items: v2Items,
      references: [],
    });
    return { v3: { ...emptyDoc(), items: v3Items }, v2, v2Round2: round2(v2) };
  };

  const many = Array.from({ length: 300 }, (_, i) => ink(40, i));
  const long = ink(1000, 0);
  const rectGeo = { x: 120.5, y: 80.25, w: 200, h: 120, z: 0 };
  return {
    ink300x40: sample(
      many.map((m) => m.v3),
      many.map((m) => m.v2),
    ),
    ink1x1000: sample([long.v3], [long.v2]),
    shape: sample(
      [
        {
          id: newItemId(fill),
          kind: "shape",
          ...rectGeo,
          style,
          geo: "rectangle",
        },
      ],
      [
        {
          id: `wb:${uuid(rnd)}`,
          kind: "shape",
          geo: "rectangle",
          ...rectGeo,
          style,
        },
      ],
    ),
  };
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe("v3 体积基准", () => {
  const samples = makeSamples();
  const rows = Object.entries(samples).map(([name, s]) => ({
    name,
    v2: bytes(s.v2),
    v2Round2: bytes(s.v2Round2),
    v3: bytes(encodeDoc(s.v3)),
  }));
  const row = (name: string) => rows.find((r) => r.name === name)!;

  it("打印对比表", () => {
    console.table(rows);
    expect(rows).toHaveLength(3);
  });

  it("300 条 × 40 点墨迹：不到 v2 的 1/5，也小于保留 2 位小数的 v2", () => {
    const r = row("ink300x40");
    expect(r.v3).toBeLessThanOrEqual(60_000);
    expect(r.v3).toBeLessThan(r.v2 / 5);
    expect(r.v3).toBeLessThan(r.v2Round2 / 2);
  });

  it("1,000 点长线：不超过 3 KB，且小于 v2 的 1/6", () => {
    const r = row("ink1x1000");
    expect(r.v3).toBeLessThanOrEqual(3_000);
    expect(r.v3).toBeLessThan(r.v2 / 6);
  });

  it("缺省矩形：对象本身不超过 80 B，整份文档（含外壳）不超过 v2 的 2/3", () => {
    const r = row("shape");
    expect(bytes(encodeItem(samples.shape.v3.items[0]!))).toBeLessThanOrEqual(
      80,
    );
    expect(r.v3).toBeLessThanOrEqual((r.v2 * 2) / 3);
  });
});
