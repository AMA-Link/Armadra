// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `Spinner` 不再写死英文读屏名：没传 `aria-label` 就是装饰图标（`aria-hidden`，
 * 旁边已经有字说明了）；要给读屏名字的调用处必须传本地化的表达式，不能是写死
 * 的字面量。`ui/` 是生成文件，不扫。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === "ui" && directory === SRC ? [] : walk(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe("Spinner 的无障碍名", () => {
  it("没有写死字面量的 aria-label（不传就是装饰图标）", () => {
    const missing: string[] = [];
    let sites = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<Spinner\b[^>]*?\/>/gs)) {
        sites += 1;
        const tag = match[0];
        // 表达式（`t(…)`、由 `t` 算出的变量）算本地化；写死的字面量不算。
        if (/aria-label="/.test(tag)) {
          const line = text.slice(0, match.index).split("\n").length;
          missing.push(`${relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(sites).toBeGreaterThanOrEqual(20);
    expect(missing).toEqual([]);
  });
});
