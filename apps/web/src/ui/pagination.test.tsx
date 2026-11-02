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
});
