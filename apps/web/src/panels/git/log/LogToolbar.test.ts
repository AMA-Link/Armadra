import { describe, expect, it } from "vitest";

import { nextRepositories } from "./LogToolbar";

const ALL = [".", "Armadra", "armadra-cloud"];

describe("仓库色块按钮的下一份筛选", () => {
  it("全部可见时隐藏一个，列出其余", () => {
    expect(nextRepositories(ALL, [], "Armadra", false)).toEqual([
      ".",
      "armadra-cloud",
    ]);
  });

  it("再点回来凑齐全部 = 不筛选（空列表）", () => {
    expect(nextRepositories(ALL, [".", "armadra-cloud"], "Armadra", false)).toEqual(
      [],
    );
  });

  it("最后一个不能隐藏", () => {
    expect(nextRepositories(ALL, ["Armadra"], "Armadra", false)).toEqual([
      "Armadra",
    ]);
  });

  it("⌘ 点击只看这一个；已经只看它时回到全部", () => {
    expect(nextRepositories(ALL, [], "armadra-cloud", true)).toEqual([
      "armadra-cloud",
    ]);
    expect(nextRepositories(ALL, ["armadra-cloud"], "armadra-cloud", true)).toEqual(
      [],
    );
  });

  it("结果按发现顺序排列，与点击先后无关", () => {
    expect(nextRepositories(ALL, ["armadra-cloud"], ".", false)).toEqual([
      ".",
      "armadra-cloud",
    ]);
  });
});
