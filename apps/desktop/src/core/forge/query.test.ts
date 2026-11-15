/** 限定词解析（契约 §112.1）。 */

import { describe, expect, it } from "vitest";
import { FORGE_QUERY_MAX, forgeNodeDataSchema } from "@armadra/shared";

import {
  MAX_QUERY,
  QueryParts,
  effectiveSort,
  parseQuery,
  serialize,
  stateOf,
  takeSort,
  withoutScope,
  withoutState,
} from "./query";

describe("parseQuery", () => {
  it("限定词、取反、引号值与自由文本分开", () => {
    const parsed = parseQuery(
      'is:open label:"good first issue" -author:bot sync crash',
    );
    expect(parsed.text).toBe("sync crash");
    expect(parsed.qualifiers).toEqual([
      { key: "is", value: "open", negated: false, raw: "is:open" },
      {
        key: "label",
        value: "good first issue",
        negated: false,
        raw: 'label:"good first issue"',
      },
      { key: "author", value: "bot", negated: true, raw: "-author:bot" },
    ]);
  });

  it("没有值的冒号、网址一类按普通文本", () => {
    const parsed = parseQuery("label: fix http://x.test");
    expect(parsed.qualifiers).toEqual([]);
    expect(parsed.text).toBe("label: fix http://x.test");
  });

  it("重新拼回时带引号的值保持一个词", () => {
    expect(serialize(parseQuery('label:"a b" -label:c word'))).toBe(
      'label:"a b" -label:c word',
    );
  });

  it("词数与长度有上限，不会无限增长", () => {
    const many = Array.from(
      { length: 100 },
      (_, i) => `k${String.fromCharCode(97 + (i % 26))}:x`,
    ).join(" ");
    expect(parseQuery(many).qualifiers).toHaveLength(40);
    expect(parseQuery("a".repeat(5000)).text.length).toBeLessThanOrEqual(512);
  });

  it("上限与节点数据共用一个常量：路由收得下的，节点也存得下", () => {
    expect(MAX_QUERY).toBe(FORGE_QUERY_MAX);
    const base = { kind: "forge" as const };
    expect(
      forgeNodeDataSchema.safeParse({
        ...base,
        query: "a".repeat(MAX_QUERY),
      }).success,
    ).toBe(true);
    expect(
      forgeNodeDataSchema.safeParse({
        ...base,
        query: "a".repeat(MAX_QUERY + 1),
      }).success,
    ).toBe(false);
  });
});

describe("状态、范围与排序", () => {
  it("is:/state: 给状态，取第一个；withoutState 去掉它们", () => {
    const parsed = parseQuery("is:closed state:open label:x");
    expect(stateOf(parsed)).toBe("closed");
    expect(serialize(withoutState(parsed))).toBe("label:x");
    expect(stateOf(parseQuery("label:x"))).toBeUndefined();
    expect(stateOf(parseQuery("-is:open"))).toBeUndefined();
  });

  it("repo:/org:/user:/type: 与 is:issue|pr 被丢掉并原样回报", () => {
    const result = withoutScope(
      parseQuery("repo:evil/x is:pr org:o type:issue label:a"),
    );
    expect(result.dropped).toEqual([
      "repo:evil/x",
      "is:pr",
      "org:o",
      "type:issue",
    ]);
    expect(serialize(result.parsed)).toBe("label:a");
  });

  it("sort: 词取出来；参数优先，缺省按更新时间倒序", () => {
    expect(takeSort(parseQuery("sort:created-asc x")).sort).toBe("created");
    expect(takeSort(parseQuery("sort:bogus")).sort).toBeUndefined();
    const fromQuery = effectiveSort(
      parseQuery("sort:comments-asc"),
      undefined,
      undefined,
    );
    expect([fromQuery.sort, fromQuery.direction]).toEqual(["comments", "asc"]);
    const fromParam = effectiveSort(
      parseQuery("sort:comments-asc"),
      "created",
      "desc",
    );
    expect([fromParam.sort, fromParam.direction]).toEqual(["created", "desc"]);
    const none = effectiveSort(parseQuery(""), undefined, undefined);
    expect([none.sort, none.direction]).toEqual(["updated", "desc"]);
  });
});

describe("QueryParts", () => {
  it("认领的拿走，剩下的原样当 unsupported", () => {
    const parts = new QueryParts(
      parseQuery("label:a -label:b review:approved is:draft hello"),
    );
    expect(parts.take("label").map((item) => item.value)).toEqual(["a"]);
    expect(parts.take("label", true).map((item) => item.value)).toEqual(["b"]);
    expect(parts.takeIs("draft")).toBe(true);
    expect(parts.takeIs("draft")).toBe(false);
    expect(parts.rest()).toEqual(["review:approved"]);
    expect(parts.text).toBe("hello");
  });
});
