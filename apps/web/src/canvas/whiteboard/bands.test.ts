import { describe, expect, it } from "vitest";

import { backZ, frontZ, isOverBand, nextUnderZ, OVER_Z } from "./bands";

describe("bands", () => {
  it("分带按 OVER_Z 切", () => {
    expect(isOverBand(OVER_Z)).toBe(true);
    expect(isOverBand(OVER_Z - 1)).toBe(false);
  });
  it("新对象落在下带最上面，忽略上带", () => {
    expect(nextUnderZ([])).toBe(1);
    expect(nextUnderZ([3, OVER_Z + 5, 7])).toBe(8);
  });
  it("置顶永远在上带且压过已有上带，置底永远 ≤ -1", () => {
    expect(frontZ([1, 2])).toBe(OVER_Z);
    expect(frontZ([OVER_Z + 3])).toBe(OVER_Z + 4);
    expect(backZ([5, 9])).toBe(-1);
    expect(backZ([-4, 2])).toBe(-5);
  });
});
