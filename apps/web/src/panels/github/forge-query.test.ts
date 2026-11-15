import { describe, expect, it } from "vitest";

import {
  qualifierValues,
  setQualifier,
  stateFromQuery,
  toggleQualifier,
  tokenize,
} from "./forge-query";

describe("限定词串", () => {
  it("按空白切词，引号里的空白不切", () => {
    expect(tokenize('label:"good first issue" author:x  sync')).toEqual([
      'label:"good first issue"',
      "author:x",
      "sync",
    ]);
    expect(tokenize("")).toEqual([]);
  });

  it("读限定词的值，去引号，键不分大小写", () => {
    const query = 'Label:core label:"good first issue" author:x free';
    expect(qualifierValues(query, "label")).toEqual([
      "core",
      "good first issue",
    ]);
    expect(qualifierValues(query, "author")).toEqual(["x"]);
    expect(qualifierValues(query, "milestone")).toEqual([]);
  });

  it("写限定词：整体替换，其余词原样保留；空数组即去掉", () => {
    expect(setQualifier("author:a sync", "author", ["b"])).toBe(
      "sync author:b",
    );
    expect(setQualifier("author:a sync", "author", [])).toBe("sync");
    expect(setQualifier("", "milestone", ["v 1"])).toBe('milestone:"v 1"');
  });

  it("多值限定词切换一个值", () => {
    expect(toggleQualifier("", "label", "core")).toBe("label:core");
    expect(toggleQualifier("label:core", "label", "web")).toBe(
      "label:core label:web",
    );
    expect(toggleQualifier("label:core label:web", "label", "core")).toBe(
      "label:web",
    );
  });

  it("is: 优先于状态切换；merged 归入已关闭", () => {
    expect(stateFromQuery("is:closed x")).toBe("closed");
    expect(stateFromQuery("is:merged")).toBe("closed");
    expect(stateFromQuery("is:open")).toBe("open");
    expect(stateFromQuery("is:pr label:x")).toBeNull();
  });
});
