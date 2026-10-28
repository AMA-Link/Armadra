import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChartContainer } from "./chart";

afterEach(cleanup);

/** 图表配色的 `<style>`：拼进去的 id、键与颜色都转义过，跳不出选择器与声明。 */
describe("ChartContainer 的样式表", () => {
  it("恶意的 id、键与颜色写不进额外的规则", () => {
    const { container } = render(
      <ChartContainer
        id={'x"] {} body { color: red } [a="'}
        config={{
          "good-key": { label: "好", color: "hsl(10 20% 30%)" },
          "bad}key": { label: "坏键", color: "#fff" },
          evil: { label: "坏色", color: "red; } body { display: none" },
          tag: { label: "标签", color: "</style><script>pwned()</script>" },
        }}
      >
        <div />
      </ChartContainer>,
    );
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain("--color-good-key: hsl(10 20% 30%);");
    expect(css).toContain("--color-badkey: #fff;");
    expect(css).not.toContain("display: none");
    expect(css).not.toContain("<");
    // 每个主题只有一条规则：id 里的花括号都在字符串里。
    expect(css.match(/"\s*\]\s*\{/g)).toHaveLength(2);
    // 选择器里的 id 被转义成一个 CSS 字符串。
    expect(css).toContain('[data-chart="chart-x\\22 ] {} body');
  });
});
