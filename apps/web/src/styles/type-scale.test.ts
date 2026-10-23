// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TYPE_RULES } from "../lib/class-scan";
import { LEGACY_BUDGET } from "./class-guards.budget";

/**
 * 字号阶梯是 22 / 17 / 15 / 13 / 12 / 11 六档（`tokens.css`、设计系统 §2.6），界面里不出现
 * 11px 以下。这里扫源码里写死的 8–10px，免得有人为了塞进一个小徽标又退回去。
 *
 * 功能代码只写语义字号类（`text-display / title / section / body / meta / caption`），
 * 任意值 `text-[13px]`、`text-[length:var(--text-*)]` 与 Tailwind 刻度 `text-sm / xs / base`
 * 由 `class-guards.test.ts` 按 `TYPE_RULES` 登记存量并拦新增（手机输入档的
 * `text-base md:text-sm` 只在 `ui/` 里用，不在扫描范围）。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const TOO_SMALL = /text-\[(?:[0-9]|10)px\]|font-size:\s*(?:[0-9]|10)px/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("字号阶梯", () => {
  it("源码里没有 11px 以下的字号", () => {
    const offenders = sources(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          TOO_SMALL.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("语义字号类", () => {
  const appCss = readFileSync(join(SRC, "styles/app.css"), "utf8");

  it.each(["display", "title", "section", "body", "meta", "caption"])(
    "text-%s 在 @theme 里声明了字号与行高",
    (tier) => {
      expect(appCss).toMatch(new RegExp(`--text-${tier}:\\s*\\d+px;`));
      expect(appCss).toMatch(
        new RegExp(`--text-${tier}--line-height:\\s*\\d+px;`),
      );
    },
  );

  it("字号规则都登记了存量块，由 class-guards 拦新增", () => {
    for (const rule of TYPE_RULES)
      expect(LEGACY_BUDGET).toHaveProperty(rule.id);
  });
});
