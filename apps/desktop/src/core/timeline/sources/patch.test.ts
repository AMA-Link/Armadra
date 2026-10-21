import { describe, expect, it } from "vitest";

import { parseApplyPatch } from "./patch";

describe("parseApplyPatch", () => {
  it("reads add, update with several hunks, move and delete", () => {
    const files = parseApplyPatch(
      [
        "*** Begin Patch",
        "*** Add File: a.txt",
        "+one",
        "+two",
        "*** Update File: b.txt",
        "*** Move to: c.txt",
        "@@",
        " keep",
        "-old",
        "+new",
        "@@ later",
        "-x",
        "+y",
        "*** Delete File: d.txt",
        "*** End Patch",
      ].join("\n"),
    );
    expect(files).toEqual([
      { op: "add", path: "a.txt", oldText: null, newText: "one\ntwo" },
      {
        op: "update",
        path: "b.txt",
        movedTo: "c.txt",
        oldText: "keep\nold\n\nx",
        newText: "keep\nnew\n\ny",
      },
      { op: "delete", path: "d.txt", oldText: "", newText: "" },
    ]);
  });

  it("answers nothing for text that is not a patch", () => {
    expect(parseApplyPatch("hello")).toEqual([]);
  });
});
