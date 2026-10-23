import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { ShowcaseProviders } from "../harness";
import { SHOWCASE_SECTION_IDS } from "../ShowcaseApp";
import SettingsSection from "./settings";
import StatusSection from "./status";
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
  it("字号六档用真的语义类渲染，另有 text-sm / text-xs 两个刻度", () => {
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
      "text-sm",
      "text-xs",
    ]);
  });

  it("圆角七档、阴影三档（外加一张只有 1px 边的卡片）", () => {
    const { container } = renderTokens();
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-radius-sample]")].map(
        (node) => node.dataset.radiusSample,
      ),
    ).toEqual([
      "rounded-tight",
      "rounded-control",
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
    ).toEqual(["none", "shadow-node", "shadow-overlay", "shadow-dialog"]);
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

describe("占位分区", () => {
  it("settings / status / motion 已登记；settings / status 仍只渲染标题（本体为空）", () => {
    for (const id of ["settings", "status", "motion"])
      expect(SHOWCASE_SECTION_IDS).toContain(id);
    // motion 已由动效包填充（见 motion.test.tsx）
    for (const Section of [SettingsSection, StatusSection]) {
      const { container, unmount } = render(<Section />);
      expect(container.childElementCount).toBe(0);
      unmount();
    }
  });
});
