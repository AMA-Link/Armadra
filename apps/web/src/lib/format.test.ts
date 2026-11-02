import { describe, expect, it } from "vitest";
import { cn } from "./cn";
import {
  formatBytes,
  formatClock,
  formatDate,
  formatDuration,
  formatElapsedTime,
  formatRelativeTime,
  spaceCjkDigits,
} from "./format";

const NOW = new Date("2026-09-04T12:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("cn", () => {
  it("合并条件 class", () => {
    const hidden = false as boolean;
    expect(cn("a", hidden && "b", ["c"])).toBe("a c");
  });

  it("后写的 Tailwind 冲突类胜出", () => {
    expect(cn("px-2 h-8", "h-12")).toBe("px-2 h-12");
  });
});

describe("formatRelativeTime", () => {
  it("一分钟内是「刚刚」", () => {
    expect(formatRelativeTime(NOW - 20 * SECOND, NOW)).toBe("刚刚");
  });

  it("分钟 / 小时", () => {
    expect(formatRelativeTime(NOW - 3 * MINUTE, NOW)).toBe("3 分钟前");
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe("2 小时前");
  });

  it("昨天与更早的天数", () => {
    expect(formatRelativeTime(NOW - 26 * HOUR, NOW)).toBe("昨天");
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe("3 天前");
  });

  it("超过一周退回日期", () => {
    expect(formatRelativeTime(new Date("2026-01-08T12:00:00.000Z"), NOW)).toBe(
      "1 月 8 日",
    );
    expect(formatRelativeTime(new Date("2024-03-02T12:00:00.000Z"), NOW)).toBe(
      "2024 年 3 月 2 日",
    );
  });

  it("未来时间用「后」", () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe("5 分钟后");
    expect(formatRelativeTime(NOW + 10 * SECOND, NOW)).toBe("马上");
  });

  it("解析不了就给空串，交给调用方决定占位", () => {
    expect(formatRelativeTime("不是时间", NOW)).toBe("");
  });
});

describe("formatElapsedTime", () => {
  it("略超前（服务端时钟快）的已发生时刻是「刚刚」，不是「马上」", () => {
    expect(formatElapsedTime(NOW + 10 * SECOND, NOW)).toBe("刚刚");
    expect(formatElapsedTime(NOW + 5 * MINUTE, NOW)).toBe("刚刚");
  });

  it("过去的时刻与 formatRelativeTime 一致", () => {
    expect(formatElapsedTime(NOW - 3 * MINUTE, NOW)).toBe("3 分钟前");
    expect(formatElapsedTime("不是时间", NOW)).toBe("");
  });
});

describe("formatBytes", () => {
  it("1024 进制", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("三位数以上不带小数", () => {
    expect(formatBytes(700 * 1024)).toBe("700 KB");
  });

  it("负数保留符号，非有限值给破折号", () => {
    expect(formatBytes(-2048)).toBe("-2 KB");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatDuration / formatClock", () => {
  it("毫秒 / 秒 / 分 / 时", () => {
    expect(formatDuration(820)).toBe("820 毫秒");
    expect(formatDuration(4200)).toBe("4.2 秒");
    expect(formatDuration(42_000)).toBe("42 秒");
    expect(formatDuration(185_000)).toBe("3 分 05 秒");
    expect(formatDuration(4_800_000)).toBe("1 时 20 分");
  });

  it("非法值给破折号", () => {
    expect(formatDuration(-1)).toBe("—");
  });

  it("紧凑计时", () => {
    expect(formatClock(7_000)).toBe("0:07");
    expect(formatClock(760_000)).toBe("12:40");
    expect(formatClock(3_723_000)).toBe("1:02:03");
  });
});

describe("formatDate", () => {
  const day = new Date(2025, 9, 9, 20, 30);

  it("中文数字与汉字之间留空格，与 formatRelativeTime 的日期写法一致", () => {
    expect(formatDate(day, undefined, "zh-CN")).toBe("2025 年 10 月 9 日");
    expect(
      formatDate(day, { dateStyle: "medium", timeStyle: "short" }, "zh-CN"),
    ).toBe("2025 年 10 月 9 日 20:30");
    expect(formatRelativeTime(new Date(2024, 2, 2, 12), NOW)).toBe(
      "2024 年 3 月 2 日",
    );
  });

  it("英文保持 Intl 的写法", () => {
    expect(formatDate(day, undefined, "en")).toBe("Oct 9, 2025");
  });

  it("解析不了给空串", () => {
    expect(formatDate("不是时间", undefined, "zh-CN")).toBe("");
  });

  it("spaceCjkDigits 只在数字与汉字相邻处加空格", () => {
    expect(spaceCjkDigits("2026年12月1日")).toBe("2026 年 12 月 1 日");
    expect(spaceCjkDigits("3 小时前")).toBe("3 小时前");
    expect(spaceCjkDigits("build-01")).toBe("build-01");
  });
});
