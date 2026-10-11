import { describe, expect, it } from "vitest";
import {
  CLUSTER_GAP,
  LAYER_GAP,
  SIBLING_GAP,
  boxesTooClose,
  type LayoutDirection,
} from "@armadra/shared";

import {
  MAX_DEPTH,
  clearOffset,
  firstCrowdedPair,
  tidy,
  type TidyBox,
  type TidyLink,
} from "./tidy";

/**
 * 整理的「不重叠」保证（#319），用随机画布做属性测试。
 *
 * 种子固定（mulberry32），失败时报出种子就能复现。每个画布混着 960×600 的大
 * 终端、Agent、便签与白板散件，链接有主从也有对等，两个方向都排。断言：
 *
 * - 任意两个整理单元相距至少 `SIBLING_GAP`（白板孤岛内部是用户自己摆的，
 *   孤岛内的两个对象不比，但孤岛和别的单元要比）；
 * - 白板孤岛内部相对位置不变；
 * - 每个盒子都有落点；
 * - 幂等：把结果当原位置再排一次，结果不变。
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES = [
  { width: 960, height: 600 }, // 终端缺省尺寸
  { width: 1200, height: 800 }, // 拉大的终端
  { width: 240, height: 200 }, // 便签
  { width: 640, height: 440 },
  { width: 320, height: 200 }, // 终端最小尺寸
];

interface Canvas {
  boxes: TidyBox[];
  links: TidyLink[];
}

function randomCanvas(random: () => number): Canvas {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)]!;
  const count = 1 + Math.floor(random() * 30);
  const boxes: TidyBox[] = [];
  for (let index = 0; index < count; index += 1) {
    const roll = random();
    if (roll < 0.2) {
      // 白板散件：小、挤在一块，常常自成孤岛（也常常彼此重叠）。
      boxes.push({
        id: `w${index}`,
        x: Math.round(random() * 600),
        y: Math.round(random() * 600),
        width: 20 + Math.round(random() * 200),
        height: 10 + Math.round(random() * 120),
        kind: "wb",
      });
      continue;
    }
    const size = pick(SIZES);
    boxes.push({
      id: `n${index}`,
      // 故意让原位置大量重叠：整理前叠成一堆是最常见的输入。
      x: Math.round(random() * 3000) - 500,
      y: Math.round(random() * 2000) - 500,
      ...size,
      kind: roll < 0.65 ? "agent" : "node",
    });
  }
  const agents = boxes.filter((box) => box.kind === "agent");
  const links: TidyLink[] = [];
  const linkCount = Math.floor(random() * count * 1.5);
  for (let index = 0; index < linkCount; index += 1) {
    if (agents.length >= 2 && random() < 0.6) {
      const source = pick(agents).id;
      const target = pick(agents).id;
      links.push({ source, target, role: "supervises" });
    } else {
      links.push({ source: pick(boxes).id, target: pick(boxes).id });
    }
  }
  return { boxes, links };
}

/** 白板孤岛：与 tidy 内部同一条规则（相距 ≤ 24 并成一岛），测试里自己算一遍。 */
function islands(boxes: readonly TidyBox[]): Map<string, string> {
  const wb = boxes.filter((box) => box.kind === "wb");
  const parent = new Map(wb.map((box) => [box.id, box.id]));
  const find = (id: string): string => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  for (const a of wb) {
    for (const b of wb) {
      if (a.id < b.id && boxesTooClose(at(a), at(b), 24 + 1e-9)) {
        parent.set(find(b.id), find(a.id));
      }
    }
  }
  const result = new Map<string, string>();
  for (const box of boxes) {
    result.set(box.id, box.kind === "wb" ? `island:${find(box.id)}` : box.id);
  }
  return result;
}

function at(box: TidyBox) {
  return { x: box.x ?? 0, y: box.y ?? 0, width: box.width, height: box.height };
}

/** 排完之后的整理单元矩形（孤岛取成员包围盒）。 */
function unitRects(
  boxes: readonly TidyBox[],
  positions: Record<string, { x: number; y: number }>,
) {
  const unitOf = islands(boxes);
  const grouped = new Map<
    string,
    { x: number; y: number; r: number; b: number }
  >();
  for (const box of boxes) {
    const point = positions[box.id]!;
    const key = unitOf.get(box.id)!;
    const current = grouped.get(key);
    const right = point.x + box.width;
    const bottom = point.y + box.height;
    grouped.set(
      key,
      current
        ? {
            x: Math.min(current.x, point.x),
            y: Math.min(current.y, point.y),
            r: Math.max(current.r, right),
            b: Math.max(current.b, bottom),
          }
        : { x: point.x, y: point.y, r: right, b: bottom },
    );
  }
  return [...grouped.entries()].map(([id, rect]) => ({
    id,
    x: rect.x,
    y: rect.y,
    width: rect.r - rect.x,
    height: rect.b - rect.y,
  }));
}

const DIRECTIONS: LayoutDirection[] = ["vertical", "horizontal"];

describe("tidy · 不重叠（#319）", () => {
  for (const direction of DIRECTIONS) {
    it(`随机画布（${direction}）：单元之间至少隔兄弟间距，孤岛不散，幂等`, () => {
      for (let seed = 1; seed <= 300; seed += 1) {
        const random = mulberry32(seed * 7919);
        const { boxes, links } = randomCanvas(random);
        const aspect = 0.5 + random() * 3;
        const options = { aspect, direction };
        const positions = tidy(boxes, links, options);

        // 每个盒子都有落点，坐标是有限数。
        for (const box of boxes) {
          const point = positions[box.id];
          expect(point, `seed ${seed}: ${box.id}`).toBeDefined();
          expect(Number.isFinite(point!.x) && Number.isFinite(point!.y)).toBe(
            true,
          );
        }

        const rects = unitRects(boxes, positions);
        const crowded = firstCrowdedPair(rects, SIBLING_GAP);
        expect(
          crowded && [rects[crowded[0]]!.id, rects[crowded[1]]!.id],
          `seed ${seed}`,
        ).toBeNull();

        // 孤岛内部的相对位置原样保留。
        const unitOf = islands(boxes);
        const anchor = new Map<string, TidyBox>();
        for (const box of boxes) {
          const key = unitOf.get(box.id)!;
          const first = anchor.get(key);
          if (!first) {
            anchor.set(key, box);
            continue;
          }
          const p = positions[box.id]!;
          const q = positions[first.id]!;
          expect(p.x - q.x, `seed ${seed}`).toBe(at(box).x - at(first).x);
          expect(p.y - q.y, `seed ${seed}`).toBe(at(box).y - at(first).y);
        }

        // 幂等：排好的画布再排一次不动。
        const moved = boxes.map((box) => ({ ...box, ...positions[box.id]! }));
        expect(tidy(moved, links, options), `seed ${seed}`).toEqual(positions);
      }
    });
  }

  it("截图里的派发扇出：协调者居中于三个 Agent 正上方，层距与兄弟间距都够", () => {
    const terminal = { width: 960, height: 600 };
    // 原位置照着截图：三个 Agent 一字排开、间隙很窄，协调者压在中间那个上面。
    const boxes: TidyBox[] = [
      { id: "lead", x: 1100, y: 0, ...terminal, kind: "agent" },
      { id: "a1", x: 0, y: 560, ...terminal, kind: "agent" },
      { id: "a2", x: 1000, y: 560, ...terminal, kind: "agent" },
      { id: "a3", x: 2000, y: 560, ...terminal, kind: "agent" },
    ];
    const links: TidyLink[] = ["a1", "a2", "a3"].map((target) => ({
      source: "lead",
      target,
      role: "supervises",
    }));
    const positions = tidy(boxes, links, { direction: "vertical" });
    const [a1, a2, a3] = ["a1", "a2", "a3"].map((id) => positions[id]!);
    const lead = positions.lead!;

    // 三个 Agent 同一层、等距、相邻之间隔兄弟间距。
    expect(a1!.y).toBe(a2!.y);
    expect(a2!.y).toBe(a3!.y);
    expect(a2!.x - a1!.x).toBe(960 + SIBLING_GAP);
    expect(a3!.x - a2!.x).toBe(960 + SIBLING_GAP);
    // 协调者在上一层，中间留出一个层距给扇出的弯折与标签。
    expect(a1!.y - (lead.y + 600)).toBe(LAYER_GAP.vertical);
    // 协调者水平居中于三个 Agent。
    const middle = (a1!.x + a3!.x + 960) / 2;
    expect(Math.abs(lead.x + 480 - middle)).toBeLessThanOrEqual(8);
    expect(lead.x).toBe(a2!.x);

    // 横向：协调者在左、Agent 在右一列。
    const across = tidy(boxes, links, { direction: "horizontal" });
    expect(across.a1!.x - (across.lead!.x + 960)).toBe(LAYER_GAP.horizontal);
    expect(across.a2!.y - (across.a1!.y + 600)).toBe(SIBLING_GAP);
  });

  it("主从链超过深度上限：每个单元都有落点，互不重叠", () => {
    const count = MAX_DEPTH + 12;
    const boxes: TidyBox[] = Array.from({ length: count }, (_, index) => ({
      id: `c${index}`,
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      kind: "agent",
    }));
    const links: TidyLink[] = boxes.slice(1).map((box, index) => ({
      source: boxes[index]!.id,
      target: box.id,
      role: "supervises",
    }));
    const positions = tidy(boxes, links, { aspect: 1 });
    expect(Object.keys(positions)).toHaveLength(count);
    const rects = boxes.map((box) => ({ ...box, ...positions[box.id]! }));
    expect(firstCrowdedPair(rects, SIBLING_GAP)).toBeNull();
  });
});

describe("clearOffset", () => {
  const block = [{ x: 0, y: 0, width: 200, height: 100 }];

  it("不挡路时不动", () => {
    expect(
      clearOffset(block, [
        { x: 200 + CLUSTER_GAP, y: 0, width: 50, height: 50 },
      ]),
    ).toEqual({ x: 0, y: 0 });
  });

  it("挡路时整块让开，取位移小的方向，让开后间距足够", () => {
    // 一个扁长的障碍压在块上：往下让比往右让近。
    const wide = { x: -500, y: 50, width: 2000, height: 40 };
    const down = clearOffset(block, [wide]);
    expect(down.x).toBe(0);
    expect(down.y).toBeGreaterThan(0);
    expect(boxesTooClose({ ...block[0]!, y: down.y }, wide, CLUSTER_GAP)).toBe(
      false,
    );
    // 一个瘦高的障碍：往右让更近。
    const tall = { x: 50, y: -500, width: 40, height: 2000 };
    const right = clearOffset(block, [tall]);
    expect(right.y).toBe(0);
    expect(boxesTooClose({ ...block[0]!, x: right.x }, tall, CLUSTER_GAP)).toBe(
      false,
    );
  });

  it("随机障碍：让开之后与所有障碍都隔簇间距，位移在网格上", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = mulberry32(seed);
      const shape = () => ({
        x: Math.round(random() * 2000),
        y: Math.round(random() * 2000),
        width: 50 + Math.round(random() * 900),
        height: 50 + Math.round(random() * 600),
      });
      const blockRects = Array.from({ length: 1 + (seed % 4) }, shape);
      const obstacles = Array.from({ length: 1 + (seed % 9) }, shape);
      const shift = clearOffset(blockRects, obstacles);
      expect(shift.x % 8).toBe(0);
      expect(shift.y % 8).toBe(0);
      for (const rect of blockRects) {
        const moved = { ...rect, x: rect.x + shift.x, y: rect.y + shift.y };
        for (const obstacle of obstacles) {
          expect(
            boxesTooClose(moved, obstacle, CLUSTER_GAP),
            `seed ${seed}`,
          ).toBe(false);
        }
      }
    }
  });
});
