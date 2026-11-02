import { describe, expect, it } from "vitest";

import { paginationRange } from "@/ui/pagination";

describe("paginationRange", () => {
  it("页数不多时全列", () => {
    expect(paginationRange(0, 1)).toEqual([0]);
    expect(paginationRange(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("页数多时留首末与当前两边，断开处是 gap", () => {
    expect(paginationRange(0, 20)).toEqual([0, 1, "gap", 19]);
    expect(paginationRange(10, 20)).toEqual([0, "gap", 9, 10, 11, "gap", 19]);
    expect(paginationRange(19, 20)).toEqual([0, "gap", 18, 19]);
    expect(paginationRange(2, 20)).toEqual([0, 1, 2, 3, "gap", 19]);
  });

  it("省略号只在隐藏 2 页以上时出现，恰好隐藏 1 页就直接画出来", () => {
    // 页数 8，当前第 0 页：画 0,1 与末页，中间隐藏 2..6（5 页）。
    expect(paginationRange(0, 8)).toEqual([0, 1, "gap", 7]);
    // 当前第 3 页：画 0,2,3,4,7，隐藏 1 页（1）与 5..6（2 页）。
    expect(paginationRange(3, 8)).toEqual([0, 1, 2, 3, 4, "gap", 7]);
    // 当前第 4 页：隐藏 1..2（2 页）与 6（1 页）。
    expect(paginationRange(4, 8)).toEqual([0, "gap", 3, 4, 5, 6, 7]);
    // 页数 9，当前第 4 页：隐藏 1..2 与 6..7，两处都是 2 页。
    expect(paginationRange(4, 9)).toEqual([0, "gap", 3, 4, 5, "gap", 8]);
    // 每个缺口至少吞掉 2 页。
    for (let count = 8; count <= 30; count += 1) {
      for (let page = 0; page < count; page += 1) {
        const range = paginationRange(page, count);
        range.forEach((entry, position) => {
          if (entry !== "gap") return;
          const before = range[position - 1] as number;
          const after = range[position + 1] as number;
          expect(after - before - 1).toBeGreaterThanOrEqual(2);
        });
      }
    }
  });
});
