import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./markdown-blocks";

describe("splitMarkdownBlocks", () => {
  it("reassembles to the original text", () => {
    const text =
      "# Title\n\npara one\nstill one\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- a\n- b\n\n- c\n\nend";
    expect(splitMarkdownBlocks(text).join("")).toBe(text);
  });

  it("splits at blank lines and keeps the blank lines with the earlier block", () => {
    expect(splitMarkdownBlocks("a\n\nb\n\nc")).toEqual(["a\n\n", "b\n\n", "c"]);
  });

  it("does not split inside a fenced code block", () => {
    const blocks = splitMarkdownBlocks("```\na\n\nb\n```\n\nafter");
    expect(blocks).toEqual(["```\na\n\nb\n```\n\n", "after"]);
  });

  it("keeps an unclosed fence in the last block while streaming", () => {
    const blocks = splitMarkdownBlocks("intro\n\n```ts\nlet a;\n\nlet b;");
    expect(blocks).toEqual(["intro\n\n", "```ts\nlet a;\n\nlet b;"]);
  });

  it("keeps a loose list together", () => {
    const blocks = splitMarkdownBlocks("1. a\n\n2. b\n\n3. c\n\nnext");
    expect(blocks).toEqual(["1. a\n\n2. b\n\n3. c\n\n", "next"]);
  });

  it("keeps indented continuations with their block", () => {
    const blocks = splitMarkdownBlocks("- a\n\n  more\n\nb");
    expect(blocks).toEqual(["- a\n\n  more\n\n", "b"]);
  });

  it("is prefix-stable: growing the tail only changes the last block", () => {
    const head = "one\n\ntwo\n\n```\ncode\n\nmore\n```\n\n";
    const before = splitMarkdownBlocks(`${head}thr`);
    const after = splitMarkdownBlocks(`${head}three and more`);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)).toBe("three and more");
  });

  it("returns nothing for empty text", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
  });
});
