import { describe, expect, it } from "vitest";

import {
  MAX_CONTEXT_LINKS,
  MAX_LINK_TITLE,
  buildNodeLinks,
  contentLinksOf,
  mergeLinkDocument,
  sameLinkDocument,
  type LinkLike,
} from "./link-documents";

const node = (id: string, type = "terminal", title = id) => ({
  id,
  type,
  title,
});

describe("buildNodeLinks", () => {
  it("每个节点都有文档，无向两头都记", () => {
    const docs = buildNodeLinks(
      [node("a"), node("b"), node("s", "sticky")],
      [
        { source: "a", target: "b" },
        { source: "a", target: "s" },
      ],
    );
    expect(Object.keys(docs).sort()).toEqual(["a", "b", "s"]);
    expect(docs.s).toEqual([
      { id: "a", title: "a", kind: "terminal", role: "peer" },
    ]);
    expect(docs.a).toEqual([
      { id: "b", title: "b", kind: "terminal", role: "peer" },
      { id: "s", title: "s", kind: "sticky", role: "peer" },
    ]);
    expect(docs.b).toEqual([
      { id: "a", title: "a", kind: "terminal", role: "peer" },
    ]);
  });

  it("supervises：source 一侧看见 sub，target 一侧看见 main", () => {
    const docs = buildNodeLinks(
      [node("main"), node("sub")],
      [{ source: "main", target: "sub", role: "supervises" }],
    );
    expect(docs.main?.[0]?.role).toBe("sub");
    expect(docs.sub?.[0]?.role).toBe("main");
  });

  it("重复边取第一条，悬空边与自环跳过，过长标题截断", () => {
    const long = "长".repeat(MAX_LINK_TITLE + 5);
    const docs = buildNodeLinks(
      [node("a"), node("b", "terminal", long)],
      [
        { source: "a", target: "b", role: "supervises" },
        { source: "b", target: "a" },
        { source: "a", target: "gone" },
        { source: "a", target: "a" },
      ],
    );
    expect(docs.a).toHaveLength(1);
    expect(docs.a?.[0]?.role).toBe("sub");
    expect(Array.from(docs.a?.[0]?.title ?? "")).toHaveLength(MAX_LINK_TITLE);
    expect(docs.b?.[0]?.role).toBe("main");
  });
});

describe("mergeLinkDocument", () => {
  const shape = (id: string, sourceShapeId: string): LinkLike => ({
    id,
    title: id,
    kind: "shape",
    content: { sourceShapeId },
  });

  it("节点链接在前，内容链接按 id 与 sourceShapeId 去重，截到上限", () => {
    const nodes: LinkLike[] = [{ id: "n", title: "n", kind: "terminal" }];
    const merged = mergeLinkDocument(nodes, [
      shape("x", "wb:1"),
      shape("y", "wb:1"),
      shape("n", "wb:2"),
    ]);
    expect(merged.map((link) => link.id)).toEqual(["n", "x"]);

    const many = Array.from({ length: MAX_CONTEXT_LINKS + 3 }, (_, i) =>
      shape(`c${i}`, `wb:${i}`),
    );
    expect(mergeLinkDocument(nodes, many)).toHaveLength(MAX_CONTEXT_LINKS);
  });

  it("contentLinksOf 只留内容链接", () => {
    expect(
      contentLinksOf([
        { id: "n", title: "n", kind: "terminal" },
        shape("x", "wb:1"),
      ]).map((link) => link.id),
    ).toEqual(["x"]);
  });
});

describe("sameLinkDocument", () => {
  it("比较顺序、角色与内容", () => {
    const a: LinkLike[] = [
      { id: "n", title: "n", kind: "terminal", role: "peer" },
    ];
    expect(sameLinkDocument(undefined, [])).toBe(false);
    expect(sameLinkDocument([], [])).toBe(true);
    expect(sameLinkDocument(a, [{ ...a[0]! }])).toBe(true);
    expect(sameLinkDocument(a, [{ ...a[0]!, role: "sub" }])).toBe(false);
    expect(
      sameLinkDocument(a, [{ ...a[0]!, content: { sourceShapeId: "x" } }]),
    ).toBe(false);
  });
});
