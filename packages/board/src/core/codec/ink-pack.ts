// 墨迹点集 ↔ 紧凑串（docs/design/board-engine.md §3.2）。
//
// 二进制布局（再整体 base64url）：
//   varint 点数 n；
//   字节 flags，bit0 = 全部压力相同；置位时后跟一个压力字节，不存压力列；
//   逐点：zigzag varint 的 Δx、Δy（首点是绝对值），未置位时再跟 Δ压力。
// 坐标量化到 0.1 单位整数，压力量化到 0–62（步长 1/62，使鼠标恒 0.5 能精确往返）。
// 点数、坐标都在量化后的整数上做差，所以误差不会逐点累积。

import { fromBase64Url, toBase64Url } from "./base64url";

/** 与 `[x, y, 压力]` 同形；压力在 0–1。 */
export type InkPoint = readonly [number, number, number];

export type PackResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

/** 单条墨迹的点数上限；解码时也用它挡住畸形输入。 */
export const MAX_INK_POINTS = 4_000;

/** 坐标量化步长：0.1 单位。往返后每个坐标的误差不超过 `COORD_ERROR`。 */
export const COORD_SCALE = 10;
export const COORD_ERROR = 0.05 + 1e-9;
/** 压力量化级数；往返后压力误差不超过 `PRESSURE_ERROR`。 */
export const PRESSURE_LEVELS = 62;
export const PRESSURE_ERROR = 1 / (2 * PRESSURE_LEVELS) + 1e-9;

const MAX_VARINT_BYTES = 8;

function quantCoord(v: number): number {
  return Number.isFinite(v) ? Math.round(v * COORD_SCALE) : 0;
}

function quantPressure(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(
    PRESSURE_LEVELS,
    Math.max(0, Math.round(p * PRESSURE_LEVELS)),
  );
}

function writeVarint(out: number[], n: number): void {
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** zigzag 用算术而不是位运算：坐标差可以超过 32 位。 */
function writeSigned(out: number[], n: number): void {
  writeVarint(out, n >= 0 ? n * 2 : -n * 2 - 1);
}

export function packInk(points: readonly InkPoint[]): string {
  const n = Math.min(points.length, MAX_INK_POINTS);
  const qp: number[] = [];
  for (let i = 0; i < n; i++) qp.push(quantPressure(points[i]![2]));
  const constant = n > 0 && qp.every((p) => p === qp[0]);
  const bytes: number[] = [];
  writeVarint(bytes, n);
  if (n === 0) return toBase64Url(Uint8Array.from(bytes));
  bytes.push(constant ? 1 : 0);
  if (constant) bytes.push(qp[0]!);
  let px = 0;
  let py = 0;
  let pp = 0;
  for (let i = 0; i < n; i++) {
    const x = quantCoord(points[i]![0]);
    const y = quantCoord(points[i]![1]);
    writeSigned(bytes, x - px);
    writeSigned(bytes, y - py);
    if (!constant) writeSigned(bytes, qp[i]! - pp);
    px = x;
    py = y;
    pp = qp[i]!;
  }
  return toBase64Url(Uint8Array.from(bytes));
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number | null {
    return this.pos < this.bytes.length ? this.bytes[this.pos++]! : null;
  }
  varint(): number | null {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const b = this.byte();
      if (b === null) return null;
      value += (b & 127) * scale;
      if (b < 128) return Number.isSafeInteger(value) ? value : null;
      scale *= 128;
    }
    return null;
  }
  signed(): number | null {
    const z = this.varint();
    if (z === null) return null;
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
}

export function unpackInk(text: string): PackResult<InkPoint[]> {
  const bytes = fromBase64Url(text);
  if (!bytes) return { ok: false, error: "点集不是合法的 base64url" };
  const r = new Reader(bytes);
  const n = r.varint();
  if (n === null) return { ok: false, error: "点集缺少点数" };
  if (n > MAX_INK_POINTS) return { ok: false, error: "点数超过上限" };
  if (n === 0) return { ok: true, value: [] };
  const flags = r.byte();
  if (flags === null || flags > 1)
    return { ok: false, error: "点集标志位非法" };
  let pp = 0;
  if (flags === 1) {
    const p = r.byte();
    if (p === null || p > PRESSURE_LEVELS) {
      return { ok: false, error: "点集压力非法" };
    }
    pp = p;
  }
  const points: InkPoint[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const dx = r.signed();
    const dy = r.signed();
    const dp = flags === 1 ? 0 : r.signed();
    if (dx === null || dy === null || dp === null) {
      return { ok: false, error: "点集被截断" };
    }
    x += dx;
    y += dy;
    pp += dp;
    if (pp < 0 || pp > PRESSURE_LEVELS) {
      return { ok: false, error: "点集压力越界" };
    }
    points.push([x / COORD_SCALE, y / COORD_SCALE, pp / PRESSURE_LEVELS]);
  }
  if (r.pos !== bytes.length) return { ok: false, error: "点集有多余字节" };
  return { ok: true, value: points };
}
