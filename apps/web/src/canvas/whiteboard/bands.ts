/**
 * 白板对象的遮挡带（设计 §8 Q1：两档）。
 *
 * 引擎把白板对象画在 Canvas 上：缺省在节点下面（`canvas-under`），「置顶」后
 * 在所有节点上面（`canvas-over`）。带不是另存的字段，而是 `z` 的区间：
 * `z >= OVER_Z` 的对象在上带，其余在下带。这样存储格式不变，旧引擎读同一份
 * 文档也只是把它当成一个很大的 `zIndex`（盖在所有节点上面，语义一致）。
 */

/** 上带的起点。下带的 `z` 从 1 起向上长，到不了这么大。 */
export const OVER_Z = 1_000_000;

export function isOverBand(z: number): boolean {
  return z >= OVER_Z;
}

/** 下一个新对象的 `z`：落在下带的最上面。 */
export function nextUnderZ(zs: Iterable<number>): number {
  let top = 0;
  for (const z of zs) if (!isOverBand(z) && z > top) top = z;
  return top + 1;
}

/** 「置顶」：上带的最上面，已有上带对象的 `z` 之上。 */
export function frontZ(otherZs: Iterable<number>): number {
  let top = OVER_Z - 1;
  for (const z of otherZs) if (z > top) top = z;
  return top + 1;
}

/** 「置底」：下带的最下面（`z` ≤ 0 恒在已有对象之下）。 */
export function backZ(otherZs: Iterable<number>): number {
  let bottom = 0;
  for (const z of otherZs) if (z < bottom) bottom = z;
  return bottom - 1;
}
