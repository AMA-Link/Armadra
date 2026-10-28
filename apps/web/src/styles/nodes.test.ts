// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest 把 CSS stub 成空串，所以按文件读源文本（同 `tokens.test.ts`）。
const nodesCss = readFileSync(
  fileURLToPath(new URL("./nodes.css", import.meta.url)),
  "utf8",
);

describe("nodes.css 节点头（设计系统 §4）", () => {
  it("不再有悬停才出现的头部控件", () => {
    expect(nodesCss).not.toContain(".node-secondary-action");
    expect(nodesCss).not.toMatch(/node-header[^{]*\{[^}]*opacity:\s*0/);
  });

  it("胶囊簇最多占头部 40%", () => {
    expect(nodesCss).toMatch(/\.node-header-chips\s*\{\s*max-width:\s*40%;/);
  });
});

/** 选择器那一行 → 它那一块声明。 */
function block(selector: string): string {
  const at = nodesCss.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const open = nodesCss.indexOf("{", at);
  return nodesCss.slice(open + 1, nodesCss.indexOf("}", open));
}

describe("nodes.css 节点壳（设计系统 §4）", () => {
  it("节点阴影读 --shadow-node，只过渡边框色，阴影不做动画", () => {
    const frame = block(".node-frame {");
    expect(frame).toContain("box-shadow: var(--shadow-node)");
    expect(frame).toContain("transition: border-color var(--dur-fast)");
    expect(frame).not.toMatch(/transition:[^;]*shadow/);
  });

  it("悬停边框升到 --border-strong，且只在有悬停的设备上", () => {
    const at = nodesCss.indexOf("@media (hover: hover) and (pointer: fine)");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(nodesCss.slice(at, at + 200)).toContain("var(--border-strong)");
  });

  it("拖动中阴影抬到 --shadow-node-lift 并给 will-change", () => {
    const dragging = block('[data-dragging="true"] .node-frame {');
    expect(dragging).toContain("box-shadow: var(--shadow-node-lift)");
    expect(dragging).not.toContain("var(--shadow-node),");
    expect(dragging).toContain("will-change: transform");
  });

  it("新建入场 0.96 → 1 用 --dur-slow，减少动效下只淡入", () => {
    const entering = block('[data-entering="true"] .node-frame {');
    expect(entering).toContain("armadra-pop-in var(--dur-slow)");
    expect(nodesCss).toMatch(
      /prefers-reduced-motion[\s\S]*\[data-entering="true"\] \.node-frame[\s\S]*armadra-fade-in/,
    );
  });

  it("选中是品牌蓝 1.5px：1px 边 + 0.5px 外环，阴影同拖动抬一档", () => {
    const selected = block(
      '[data-slot="node-shell"][data-selected="true"] > .node-frame {',
    );
    expect(selected).toContain("border-color: var(--brand)");
    expect(selected).toContain("0 0 0 0.5px var(--brand)");
    expect(selected).toContain("var(--shadow-node-lift)");
  });

  it("不可连接的把手变 --danger 并抖（armadra-handle-shake 240ms）", () => {
    expect(nodesCss).toContain("connectingto:not(.valid)");
    expect(nodesCss).toContain("background: var(--danger)");
    expect(nodesCss).toContain("animation: armadra-handle-shake 240ms linear");
    expect(block("@keyframes armadra-handle-shake {")).toContain("translate");
  });
});
