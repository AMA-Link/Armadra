import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "./base64url";
import {
  COORD_ERROR,
  MAX_INK_POINTS,
  PRESSURE_ERROR,
  packInk,
  unpackInk,
  type InkPoint,
} from "./ink-pack";

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unpack(text: string): InkPoint[] {
  const r = unpackInk(text);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("base64url", () => {
  it("各种长度往返", () => {
    const rnd = rng(1);
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, () =>
        Math.floor(rnd() * 256),
      );
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(fromBase64Url(text)!)).toEqual(Array.from(bytes));
    }
  });

  it("与标准 base64 对照（去填充、换字母）", () => {
    const bytes = Uint8Array.from([251, 255, 190, 1, 2]);
    const std = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(toBase64Url(bytes)).toBe(std);
  });

  it("非法输入返回 null", () => {
    expect(fromBase64Url("ab+/")).toBeNull();
    expect(fromBase64Url("abcde")).toBeNull();
    expect(fromBase64Url("é")).toBeNull();
  });
});

describe("ink-pack", () => {
  it("空点集", () => {
    expect(unpack(packInk([]))).toEqual([]);
  });

  it("坐标误差 ≤ 0.05、压力误差 ≤ 1/124（随机轨迹，含负坐标与大坐标）", () => {
    const rnd = rng(7);
    const pts: InkPoint[] = [];
    let x = -500;
    let y = 3000;
    for (let i = 0; i < 2000; i++) {
      x += (rnd() - 0.5) * 40;
      y += (rnd() - 0.5) * 40;
      pts.push([x, y, rnd()]);
    }
    const back = unpack(packInk(pts.slice(0, MAX_INK_POINTS)));
    expect(back).toHaveLength(pts.length);
    pts.forEach((p, i) => {
      expect(Math.abs(back[i]![0] - p[0])).toBeLessThanOrEqual(COORD_ERROR);
      expect(Math.abs(back[i]![1] - p[1])).toBeLessThanOrEqual(COORD_ERROR);
      expect(Math.abs(back[i]![2] - p[2])).toBeLessThanOrEqual(PRESSURE_ERROR);
    });
  });

  it("误差不随点数累积", () => {
    const pts: InkPoint[] = Array.from({ length: 3000 }, (_, i) => [
      i * 0.123456,
      -i * 0.0777,
      0.5,
    ]);
    const back = unpack(packInk(pts));
    const last = pts.length - 1;
    expect(Math.abs(back[last]![0] - pts[last]![0])).toBeLessThanOrEqual(
      COORD_ERROR,
    );
    expect(Math.abs(back[last]![1] - pts[last]![1])).toBeLessThanOrEqual(
      COORD_ERROR,
    );
  });

  it("压力恒定：不存压力列，且 0.5 精确往返", () => {
    const flat: InkPoint[] = Array.from({ length: 100 }, (_, i) => [i, i, 0.5]);
    const varied: InkPoint[] = flat.map(([x, y], i) => [
      x,
      y,
      i % 2 ? 0.5 : 0.6,
    ]);
    expect(unpack(packInk(flat)).every((p) => p[2] === 0.5)).toBe(true);
    expect(packInk(flat).length).toBeLessThan(packInk(varied).length);
  });

  it("压力钳到 0–1，非有限数当 0", () => {
    const back = unpack(
      packInk([
        [0, 0, -3],
        [1, 1, 9],
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NaN],
      ]),
    );
    expect(back.map((p) => p[2])).toEqual([0, 1, 0]);
    expect([back[2]![0], back[2]![1]]).toEqual([0, 0]);
  });

  it("超过点数上限时截断", () => {
    const pts: InkPoint[] = Array.from(
      { length: MAX_INK_POINTS + 5 },
      (_, i) => [i, 0, 0.5],
    );
    expect(unpack(packInk(pts))).toHaveLength(MAX_INK_POINTS);
  });

  it("畸形输入返回错误而不是抛", () => {
    const good = packInk([
      [1, 2, 0.5],
      [3, 4, 0.5],
    ]);
    for (const bad of [
      "",
      "***",
      good.slice(0, -2),
      `${good}AA`,
      "_____w",
      "AQE",
    ]) {
      expect(unpackInk(bad).ok).toBe(false);
    }
    // 点数声明为 5000
    expect(
      unpackInk(toBase64Url(Uint8Array.from([0x88, 0x27, 1, 31]))).ok,
    ).toBe(false);
  });
});
