// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 命令面板的搜索框是无框的（`ui/command.tsx` 的 `CommandInput`）：键盘焦点由列表
 * 高亮表达，聚焦时只把底部分隔线升到 `--border-strong`。这条指示由组件自己画，
 * 调用处不再往里面那个 input 上加焦点环——加了就又是一圈粗环。`ui/` 不扫。
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

describe("CommandInput 焦点指示", () => {
  const sites = walk(SRC).filter((file) =>
    readFileSync(file, "utf8").includes("<CommandInput"),
  );

  it("扫到了调用处", () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it("调用处不给 CommandInput 加焦点环", () => {
    const ringed = sites.filter((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/<CommandInput\b[^>]*>/g)].some(([tag]) =>
        /className=|focus-visible:ring/.test(tag),
      );
    });
    expect(ringed.map((file) => relative(SRC, file))).toEqual([]);
  });

  it("组件自己在包裹层画聚焦时的底线", () => {
    const command = readFileSync(join(SRC, "ui/command.tsx"), "utf8");
    expect(command).toContain(
      "has-[[data-slot=command-input]:focus-visible]:border-border-strong",
    );
  });
});
