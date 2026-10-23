import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Activity } from "lucide-react";

import { installDomPolyfills, TestProviders } from "../../app/test-harness";
import { usePreferencesStore } from "../../app/preferences-store";
import { translate } from "../../i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsKpi, SettingsKpiGrid, kpiToneFor } from "./SettingsKpi";
import { SettingsPageContext } from "./page-context";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsRow } from "./SettingsRow";
import { SettingsTableCard } from "./SettingsTableCard";

installDomPolyfills();
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ settingsSubpage: null });
});

const zh = (key: string) => translate("zh-CN", key);
const view = (node: React.ReactNode) =>
  render(<TestProviders>{node}</TestProviders>);

describe("SettingsKpi", () => {
  it("大数字 + 20 格刻度 + 元信息；刻度按阈值取色", () => {
    const { container } = view(
      <SettingsKpiGrid>
        <SettingsKpi
          icon={<Activity />}
          label="CPU"
          value={82}
          percent={82}
          meta="5 小时"
        />
        <SettingsKpi label="内存" value={96} percent={96} />
        <SettingsKpi label="磁盘" value={40} percent={40} />
      </SettingsKpiGrid>,
    );
    const cards = [...container.querySelectorAll('[data-slot="settings-kpi"]')];
    expect(cards).toHaveLength(3);
    expect(
      cards.map((card) =>
        card.querySelector('[data-slot="progress"]')?.getAttribute("data-tone"),
      ),
    ).toEqual(["warn", "danger", "brand"]);
    expect(
      cards[0]!.querySelectorAll('[data-slot="progress-tick"]'),
    ).toHaveLength(20);
    expect(cards[0]!.textContent).toContain("5 小时");
    expect(
      container.querySelector('[data-slot="settings-kpi-grid"]')?.className,
    ).toContain("grid-cols-[repeat(auto-fit,minmax(200px,1fr))]");
  });

  it("值是字符串的卡不画刻度，空值写 —，趋势只在给了上一周期时出现", () => {
    const { container } = view(
      <SettingsKpiGrid>
        <SettingsKpi label="版本" value="0.10.0" />
        <SettingsKpi label="空" value={null} percent={null} />
        <SettingsKpi label="涨" value={3} trend={12.5} />
      </SettingsKpiGrid>,
    );
    const cards = [...container.querySelectorAll('[data-slot="settings-kpi"]')];
    expect(cards[0]!.querySelector('[data-slot="progress"]')).toBeNull();
    expect(cards[0]!.textContent).toContain("0.10.0");
    expect(
      cards[1]!.querySelector('[data-slot="tray-value"]')?.textContent,
    ).toBe("—");
    expect(cards[1]!.querySelector('[data-slot="progress"]')).toBeNull();
    expect(cards[1]!.querySelector('[data-slot="tray-trend"]')).toBeNull();
    expect(
      cards[2]!
        .querySelector('[data-slot="tray-trend"]')
        ?.getAttribute("data-direction"),
    ).toBe("up");
  });

  it("阈值：80 起 warn、95 起 danger，没有值时是品牌色", () => {
    expect(kpiToneFor(79)).toBe("brand");
    expect(kpiToneFor(80)).toBe("warn");
    expect(kpiToneFor(95)).toBe("danger");
    expect(kpiToneFor(null)).toBe("brand");
    expect(kpiToneFor(Number.NaN)).toBe("brand");
  });
});

describe("SettingsTableCard", () => {
  const body = (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>
            <button type="button" data-roving-item>
              甲
            </button>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>
            <button type="button" data-roving-item>
              乙
            </button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );

  it("头行：标题、分段筛选、查看全部；行内 ↑↓ 移动焦点", () => {
    const onFilter = vi.fn();
    const onViewAll = vi.fn();
    view(
      <SettingsTableCard
        title="会话"
        filter={{
          value: "all",
          onValueChange: onFilter,
          label: "筛选",
          options: [
            { value: "all", label: "全部" },
            { value: "claude", label: "Claude" },
          ],
        }}
        viewAll={{ onClick: onViewAll }}
      >
        {body}
      </SettingsTableCard>,
    );
    expect(screen.getByText("会话")).toBeTruthy();
    const list = screen.getByRole("tablist", { name: "筛选" });
    expect(list.getAttribute("data-variant")).toBe("segmented");
    fireEvent.mouseDown(within(list).getByRole("tab", { name: "Claude" }));
    fireEvent.click(within(list).getByRole("tab", { name: "Claude" }));
    fireEvent.click(
      screen.getByRole("button", { name: zh("settings.table.viewAll") }),
    );
    expect(onViewAll).toHaveBeenCalled();
    const [first, second] = [screen.getByText("甲"), screen.getByText("乙")];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
  });

  it("加载出骨架，空态出一句名词短语与动作，都不渲染表格", () => {
    const { rerender } = view(
      <SettingsTableCard title="会话" loading>
        {body}
      </SettingsTableCard>,
    );
    expect(
      document.querySelector('[data-slot="skeleton-table"]'),
    ).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    rerender(
      <TestProviders>
        <SettingsTableCard
          title="会话"
          empty={{
            title: "没有会话",
            action: <button type="button">添加</button>,
          }}
        >
          {body}
        </SettingsTableCard>
      </TestProviders>,
    );
    expect(screen.getByText("没有会话")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("SettingsPageHeader", () => {
  it("页名取自分区，没有副标题；动作在右侧", () => {
    view(
      <SettingsPageContext.Provider value={{ sectionId: "usage", query: "" }}>
        <SettingsPageHeader actions={<button type="button">刷新</button>} />
      </SettingsPageContext.Provider>,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      zh("settings.section.usage"),
    );
    const header = document.querySelector(
      '[data-slot="settings-page-header"]',
    )!;
    expect([...header.children].map((child) => child.tagName)).toEqual([
      "H2",
      "DIV",
    ]);
    expect(
      screen.queryByRole("button", { name: zh("settings.back") }),
    ).toBeNull();
  });

  it("停在子页时页名换成子页名，左侧出现返回", () => {
    usePreferencesStore.setState({ settingsSubpage: "ssh:new" });
    view(
      <SettingsPageContext.Provider
        value={{ sectionId: "machines", query: "" }}
      >
        <SettingsPageHeader />
      </SettingsPageContext.Provider>,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      zh("ssh.dialog.add"),
    );
    fireEvent.click(screen.getByRole("button", { name: zh("settings.back") }));
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
  });
});

describe("SettingsGroup / SettingsRow", () => {
  it("分组卡用 Card 自己的圆角与边，不覆盖；行带标签，脚注只在有动态值时出现", () => {
    view(
      <SettingsGroup title="组">
        <SettingsRow label="甲">
          <span>值</span>
        </SettingsRow>
        <SettingsRow label="乙" footnote="校验失败" />
      </SettingsGroup>,
    );
    const card = document.querySelector(".settings-group") as HTMLElement;
    expect(card.dataset.slot).toBe("card");
    expect(card.className).not.toMatch(/rounded-(lg|md|xl)|ring-0/);
    const rows = [
      ...document.querySelectorAll(".settings-row"),
    ] as HTMLElement[];
    expect(rows.map((row) => row.dataset.settingsLabel)).toEqual(["甲", "乙"]);
    expect(rows[0]!.textContent).toBe("甲值");
    expect(rows[1]!.textContent).toContain("校验失败");
  });
});
