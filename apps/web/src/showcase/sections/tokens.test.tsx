import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { ShowcaseProviders } from "../harness";
import { SHOWCASE_SECTION_IDS } from "../ShowcaseApp";
import TokensSection from "./tokens";

// jsdom 不加载样式表，算不出计算色：对比度读数在探针里（真实浏览器）验，这里只验结构。
vi.mock("../harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness")>()),
  tokenContrast: () => 4.5,
}));

afterEach(cleanup);

function renderTokens() {
  installDomPolyfills();
  return render(
    <ShowcaseProviders>
      <TokensSection />
    </ShowcaseProviders>,
  );
}

describe("tokens 分区（设计系统 §2）", () => {
  it("字号六档用真的语义类渲染", () => {
    const { container } = renderTokens();
    const classes = [
      ...container.querySelectorAll<HTMLElement>("[data-type-sample]"),
    ].map((node) => node.dataset.typeSample);
    expect(classes).toEqual([
      "text-display",
      "text-title",
      "text-section",
      "text-body",
      "text-meta",
      "text-caption",
    ]);
  });

  it("圆角八档、投影六个样本（卡片 / 节点 / 节点抬起 / 浮层 / 对话框 / 键帽）", () => {
    const { container } = renderTokens();
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-radius-sample]")].map(
        (node) => node.dataset.radiusSample,
      ),
    ).toEqual([
      "rounded-tight",
      "rounded-control",
      "rounded-field",
      "rounded-card",
      "rounded-panel",
      "rounded-dialog",
      "rounded-float",
      "rounded-pill",
    ]);
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-shadow-sample]")].map(
        (node) => node.dataset.shadowSample,
      ),
    ).toEqual([
      "shadow-card",
      "shadow-node",
      "shadow-node-lift",
      "shadow-overlay",
      "shadow-dialog",
      "shadow-kbd",
    ]);
  });

  it("动效：六档时长、四条曲线、按下 / 发芽缩放、六格错落", () => {
    const { container } = renderTokens();
    expect(container.querySelectorAll("[data-motion-sample]")).toHaveLength(6);
    expect(container.querySelectorAll("[data-curve-sample]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-scale-sample]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-stagger-sample]")).toHaveLength(6);
    expect(container.querySelector("[data-hairline-sample]")).not.toBeNull();
  });

  it("状态三件套含 caution 的 -text / -soft", () => {
    const { container } = renderTokens();
    for (const token of ["--caution", "--caution-soft"])
      expect(container.querySelector(`[data-token="${token}"]`)).not.toBeNull();
    expect(container.textContent).toContain("--caution-text");
  });
});

describe("新增分区", () => {
  it("settings / status / motion 已登记", () => {
    for (const id of ["settings", "status", "motion"])
      expect(SHOWCASE_SECTION_IDS).toContain(id);
  });
});
