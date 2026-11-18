// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 全局样式表必须从应用入口引进来。jsdom 不加载 CSS，组件测试看不出样式表丢了：
 * 画布样式曾只挂在旧画布入口上，入口删掉后舞台、宿主与缩略图全部失去样式，
 * 缩略图的 Canvas 铺满舞台、吞掉所有点击。
 */
const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("应用入口引入的全局样式表", () => {
  it.each(["app.css", "nodes.css", "canvas.css"])("%s", (name) => {
    expect(source("../main.tsx")).toContain(`import "./styles/${name}";`);
  });
});
