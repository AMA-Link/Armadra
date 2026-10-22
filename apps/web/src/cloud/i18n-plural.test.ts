import { describe, expect, it } from "vitest";

import { messages } from "@/i18n";
import { pluralForm, tp } from "./i18n-plural";

for (const locale of ["zh-CN", "en"] as const) {
  messages[locale]["test.members.one"] =
    locale === "en" ? "{count} member" : "{count} 位成员";
  messages[locale]["test.members.other"] =
    locale === "en" ? "{count} members" : "{count} 位成员";
}

describe("tp", () => {
  it("英文按 Intl.PluralRules 取 one / other", () => {
    expect(pluralForm("en", 1)).toBe("one");
    expect(pluralForm("en", 0)).toBe("other");
    expect(tp("test.members", 1, {}, "en")).toBe("1 member");
    expect(tp("test.members", 3, {}, "en")).toBe("3 members");
  });

  it("中文恒为 other，两条同文", () => {
    expect(pluralForm("zh-CN", 1)).toBe("other");
    expect(tp("test.members", 1, {}, "zh-CN")).toBe("1 位成员");
    expect(tp("test.members", 8, {}, "zh-CN")).toBe("8 位成员");
  });

  it("其余占位符照常填，count 不会被覆盖", () => {
    messages.en["test.days.other"] = "{count} days in {team}";
    expect(tp("test.days", 5, { team: "rd" }, "en")).toBe("5 days in rd");
  });
});
