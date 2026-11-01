import { describe, expect, it } from "vitest";

import {
  checkElicitationAnswer,
  schemaOf,
  storedElicitation,
} from "./elicitation";

describe("schemaOf: multi-select and titled enums", () => {
  it("keeps an array of an enum and its default", () => {
    expect(
      schemaOf({
        type: "object",
        properties: {
          tags: {
            type: "array",
            title: "Tags",
            items: { type: "string", enum: ["a", "b"] },
            minItems: 1,
            maxItems: 2,
            default: ["a", "zzz"],
          },
        },
        required: ["tags"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        tags: {
          type: "array",
          title: "Tags",
          items: { enum: ["a", "b"] },
          minItems: 1,
          maxItems: 2,
          // 默认值里不在选项里的丢掉。
          default: ["a"],
        },
      },
      required: ["tags"],
    });
  });

  it("folds items.anyOf / oneOf const+title into enum + enumNames", () => {
    for (const key of ["anyOf", "oneOf"]) {
      expect(
        schemaOf({
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: {
                [key]: [
                  { const: "a", title: "Alpha" },
                  { const: "b", title: "Beta" },
                ],
              },
            },
          },
        })?.properties.tags,
      ).toEqual({
        type: "array",
        items: { enum: ["a", "b"], enumNames: ["Alpha", "Beta"] },
      });
    }
  });

  it("folds a string oneOf into enum + enumNames", () => {
    expect(
      schemaOf({
        type: "object",
        properties: {
          size: {
            type: "string",
            oneOf: [{ const: "s", title: "Small" }, { const: "l" }],
            default: "s",
          },
        },
      })?.properties.size,
    ).toEqual({
      type: "string",
      enum: ["s", "l"],
      enumNames: ["Small", "l"],
      default: "s",
    });
  });

  it("still refuses what a page cannot draw", () => {
    const one = (field: unknown) =>
      schemaOf({ type: "object", properties: { f: field } });
    // 没有选项的数组、非字符串的数组、认不出的 oneOf。
    expect(one({ type: "array", items: { type: "string" } })).toBeUndefined();
    expect(one({ type: "array", items: { type: "integer" } })).toBeUndefined();
    expect(one({ type: "array", items: { enum: [] } })).toBeUndefined();
    expect(one({ type: "string", oneOf: [{ title: "x" }] })).toBeUndefined();
    expect(one({ type: "object" })).toBeUndefined();
  });
});

describe("checkElicitationAnswer: arrays", () => {
  const stored = storedElicitation({
    message: "Pick",
    requestedSchema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { enum: ["a", "b", "c"] },
          minItems: 1,
          maxItems: 2,
        },
      },
      required: ["tags"],
    },
  });
  const answer = (tags: unknown) =>
    checkElicitationAnswer(stored, { action: "accept", content: { tags } });

  it("passes the picked options through as an array", () => {
    expect(answer(["a", "c"])).toEqual({
      ok: true,
      result: { action: "accept", content: { tags: ["a", "c"] } },
    });
  });

  it("refuses non-arrays, unknown options, duplicates and bad lengths", () => {
    for (const bad of ["a", ["z"], ["a", "a"], [], ["a", "b", "c"], [1]]) {
      expect(answer(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});
