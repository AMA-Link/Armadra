import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { translate } from "@/i18n";
import { ShowcaseProviders } from "../harness";
import SettingsSection from "./settings";

afterEach(cleanup);

const zh = (key: string) => translate("zh-CN", key);

function renderSection() {
  installDomPolyfills();
  return render(
    <ShowcaseProviders>
      <SettingsSection />
    </ShowcaseProviders>,
  );
}

describe("settings 分区（设计系统 §5.17）", () => {
  it("外壳：导航贴底带徽标、顶栏面包屑与搜索、内容面板里是用量页托盘", () => {
    const { container } = renderSection();
    const shell = screen.getByTestId("settings-shell");
    const nav = within(shell).getByRole("navigation", {
      name: zh("settings.title"),
    });
    expect(nav.className).not.toContain("border-r");
    // 徽标：计数与提示点各自出现在对应项里
    expect(
      nav.querySelectorAll('[data-slot="settings-nav-badge"]').length,
    ).toBe(3);
    expect(
      within(shell).getByRole("navigation", {
        name: zh("settings.breadcrumb"),
      }),
    ).toBeTruthy();
    expect(
      within(shell).getByPlaceholderText(zh("settings.search")),
    ).toBeTruthy();
    // 用量页：每家一张托盘，取不到的写 — 并带失败胶囊
    const trays = shell.querySelectorAll('[data-slot="settings-kpi"]');
    expect(trays).toHaveLength(3);
    expect(
      trays[2]!.querySelector('[data-slot="tray-value"]')?.textContent,
    ).toBe("—");
    expect(
      trays[2]!
        .querySelector('[data-slot="status-pill"]')
        ?.getAttribute("data-tone"),
    ).toBe("failed");
    // 82% 落在 warn 刻度
    expect(
      trays[0]!
        .querySelector('[data-slot="progress"]')
        ?.getAttribute("data-tone"),
    ).toBe("warn");
    expect(
      container.querySelectorAll('[data-slot="settings-page-header"]').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("Agent CLI 页：三张托盘与表格卡，本机服务页：托盘有值与全 — 两种", () => {
    const { container } = renderSection();
    const agents = container.querySelector('[data-sample="settings-agents"]')!;
    expect(agents.querySelectorAll('[data-slot="settings-kpi"]')).toHaveLength(
      3,
    );
    expect(
      agents.querySelector('[data-slot="settings-table-card"]'),
    ).not.toBeNull();
    expect(
      agents.querySelectorAll('[data-slot="status-pill"]').length,
    ).toBeGreaterThan(0);

    const service = container.querySelector(
      '[data-sample="settings-service"]',
    )!;
    const grids = service.querySelectorAll('[data-slot="settings-kpi-grid"]');
    expect(grids).toHaveLength(2);
    const unknown = [
      ...grids[1]!.querySelectorAll('[data-slot="settings-kpi"]'),
    ];
    // CPU / 内存 / 磁盘 / 运行时长 / 会话：测不出来的写 —，不画刻度
    expect(unknown).toHaveLength(5);
    expect(
      unknown.every(
        (card) => card.querySelector('[data-slot="progress"]') === null,
      ),
    ).toBe(true);
    expect(
      unknown[0]!.querySelector('[data-slot="tray-value"]')?.textContent,
    ).toBe("—");
  });

  it("表格卡的空态与骨架各一", () => {
    const { container } = renderSection();
    const states = container.querySelector(
      '[data-sample="settings-table-states"]',
    )!;
    expect(states.querySelector('[data-state-kind="empty"]')).not.toBeNull();
    expect(states.querySelector('[data-slot="skeleton-table"]')).not.toBeNull();
  });
});
