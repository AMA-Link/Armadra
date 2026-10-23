import { describe, expect, it } from "vitest";

import { translate } from "../../i18n";
import { SETTINGS_SECTIONS } from "./nav";
import { SEARCH_LIMIT, SETTINGS_SEARCH, searchSettings } from "./search-index";

const zh = (key: string) => translate("zh-CN", key);

describe("设置搜索索引", () => {
  it("每个分区至少登记一条，且没有悬空的分区 id", () => {
    for (const section of SETTINGS_SECTIONS)
      expect(
        SETTINGS_SEARCH[section.id]?.length ?? 0,
        section.id,
      ).toBeGreaterThan(0);
    const known = new Set(SETTINGS_SECTIONS.map((section) => section.id));
    for (const id of Object.keys(SETTINGS_SEARCH))
      expect(known.has(id), id).toBe(true);
  });

  it("登记的键两种语言都有值，不是键名本身", () => {
    for (const [id, keys] of Object.entries(SETTINGS_SEARCH))
      for (const key of keys)
        for (const locale of ["zh-CN", "en"] as const) {
          const value = translate(locale, key);
          expect(value, `${id} ${locale} ${key}`).not.toBe(key);
          expect(value.trim(), `${id} ${locale} ${key}`).not.toBe("");
        }
  });

  it("同一页里不重复登记", () => {
    for (const [id, keys] of Object.entries(SETTINGS_SEARCH))
      expect(new Set(keys).size, id).toBe(keys.length);
  });

  const ids = SETTINGS_SECTIONS.map((section) => section.id);
  const find = (query: string) =>
    searchSettings(
      query,
      ids,
      zh,
      (id) => SETTINGS_SECTIONS.find((section) => section.id === id)!.labelKey,
    );

  it("空查询没有结果", () => {
    expect(find("")).toEqual([]);
    expect(find("   ")).toEqual([]);
  });

  it("页名命中排在该页的行之前，行命中带键", () => {
    const hits = find("用量");
    const usagePage = hits.findIndex(
      (hit) => hit.sectionId === "usage" && hit.rowKey === null,
    );
    const usageRow = hits.findIndex(
      (hit) => hit.sectionId === "usage" && hit.rowKey !== null,
    );
    expect(usagePage).toBeGreaterThanOrEqual(0);
    expect(usageRow).toBeGreaterThan(usagePage);
    expect(hits).toContainEqual({
      sectionId: "general",
      rowKey: "settings.showUsage",
    });
  });

  it("不分大小写，只在传入的可见分区里找", () => {
    const upper = searchSettings(
      "SSH",
      ["machines"],
      (key) => translate("en", key),
      (id) => SETTINGS_SECTIONS.find((section) => section.id === id)!.labelKey,
    );
    expect(upper.length).toBeGreaterThan(0);
    expect(upper.every((hit) => hit.sectionId === "machines")).toBe(true);
  });

  it("结果有上限", () => {
    expect(find("a").length).toBeLessThanOrEqual(SEARCH_LIMIT);
    expect(find("设").length).toBeLessThanOrEqual(SEARCH_LIMIT);
  });
});
