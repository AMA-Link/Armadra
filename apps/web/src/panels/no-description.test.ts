// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { blankComments } from "../lib/scan-source";

/**
 * 设置页没有说明文字（设计系统 §6「没有说明文字」，计划 §7）：
 *
 * - 对话框与卡片不带 `*Description`（确认框把对象与后果写进标题）；
 * - 页面里没有常驻的灰字段落（`<p className="… text-muted-foreground">`）。
 *
 * 范围是设置工作台自己的文件（`SettingsDialog.tsx` 与 `settings/**`，不含测试）。
 * 例外只允许法律文本（许可证）、错误文案与 `sr-only` 的读屏说明；例外表初始为空，
 * 加一条要写清理由。
 */
const PANELS = fileURLToPath(new URL(".", import.meta.url));

/** 文件（相对 `panels/`）→ 理由。 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

const DESCRIPTION_COMPONENT =
  /\b(?:Responsive(?:Alert)?Dialog|Dialog|AlertDialog|Alert|Card|Empty|Item|Field|Sheet)Description\b/g;
const MUTED_PARAGRAPH = /<p\b[^>]*text-muted-foreground/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = [
  join(PANELS, "SettingsDialog.tsx"),
  ...sources(join(PANELS, "settings")),
];

describe("设置页没有说明文字", () => {
  it("扫到了设置工作台的文件", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("不出现任何 *Description 组件", () => {
    const offenders = files.flatMap((path) => {
      const rel = relative(PANELS, path).split(sep).join("/");
      if (rel in EXCEPTIONS) return [];
      const hits = [
        ...blankComments(readFileSync(path, "utf8")).matchAll(
          DESCRIPTION_COMPONENT,
        ),
      ];
      return hits.length > 0 ? [`${rel} ×${hits.length}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("没有常驻的灰字段落", () => {
    const offenders = files.flatMap((path) => {
      const rel = relative(PANELS, path).split(sep).join("/");
      if (rel in EXCEPTIONS) return [];
      const hits = [
        ...blankComments(readFileSync(path, "utf8")).matchAll(MUTED_PARAGRAPH),
      ];
      return hits.length > 0 ? [`${rel} ×${hits.length}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("例外表里的文件都还存在", () => {
    for (const rel of Object.keys(EXCEPTIONS))
      expect(() => statSync(join(PANELS, rel))).not.toThrow();
  });
});
