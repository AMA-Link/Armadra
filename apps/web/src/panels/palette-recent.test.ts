import { beforeEach, describe, expect, it } from "vitest";

import { RECENT_MAX, readRecent, rememberRecent } from "./palette-recent";

beforeEach(() => localStorage.clear());

describe("命令面板的最近使用", () => {
  it("新的在前、同一条不重复、最多五条", () => {
    for (const id of ["a", "b", "c", "d", "e", "f"]) rememberRecent(id);
    expect(readRecent()).toEqual(["f", "e", "d", "c", "b"]);
    expect(readRecent()).toHaveLength(RECENT_MAX);
    rememberRecent("c");
    expect(readRecent()).toEqual(["c", "f", "e", "d", "b"]);
  });

  it("存的东西坏了就当没有", () => {
    localStorage.setItem("armadra.palette.recent", "{not json");
    expect(readRecent()).toEqual([]);
    localStorage.setItem("armadra.palette.recent", '{"a":1}');
    expect(readRecent()).toEqual([]);
    localStorage.setItem("armadra.palette.recent", '["x",3,null,"y"]');
    expect(readRecent()).toEqual(["x", "y"]);
  });
});
