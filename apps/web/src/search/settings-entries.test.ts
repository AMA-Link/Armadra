import { describe, expect, it } from "vitest";

import { prepare } from "./match";
import { searchSettingsEntries, type SettingsEntry } from "./settings-entries";

function entry(
  sectionId: string,
  rowKey: string | null,
  title: string,
  page: string,
): SettingsEntry {
  return {
    sectionId,
    rowKey,
    title,
    page: rowKey ? page : "",
    primary: prepare(title),
    secondary: rowKey ? [prepare(page)] : [],
  };
}

const entries = [
  entry("defaults", null, "默认", ""),
  entry("defaults", "settings.theme", "主题", "默认"),
  entry("terminalLook", null, "终端外观", ""),
  entry("terminalLook", "terminal.settings.font", "字体", "终端外观"),
];

describe("searchSettingsEntries", () => {
  it("按页名与行名找，空查询不列", () => {
    expect(searchSettingsEntries(entries, "")).toEqual([]);
    expect(
      searchSettingsEntries(entries, "主题").map((hit) => hit.rowKey),
    ).toEqual(["settings.theme"]);
  });

  it("页名命中时该页的行也带出，页本身排在前面", () => {
    const hits = searchSettingsEntries(entries, "终端外观");
    expect(hits[0]).toMatchObject({ sectionId: "terminalLook", rowKey: null });
    expect(hits.map((hit) => hit.rowKey)).toContain("terminal.settings.font");
  });

  it("认拼音首字母", () => {
    expect(
      searchSettingsEntries(entries, "zt").map((hit) => hit.rowKey),
    ).toContain("settings.theme");
  });

  it("按上限截断", () => {
    expect(searchSettingsEntries(entries, "终端外观", 1)).toHaveLength(1);
  });
});
