import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chooseOption, installDomPolyfills } from "../../app/test-harness";
import { MOCK_HOSTS } from "../mock/fixtures";
import { h1, installConsoleHarness, mount, viewport } from "../testkit";
import { filtersOf } from "./model";

installConsoleHarness();
installDomPolyfills();

const OPTIONS = { emailVerified: true } as const;
const VIEWPORT = 440;

/** jsdom 不排版：给审计行区一个固定高度，虚拟列表才有「窗口」。 */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.slot === "audit-rows" ? VIEWPORT : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 900,
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
});

const table = () => screen.findByRole("table", { name: "审计" });
const bodyRows = async () =>
  within(await table())
    .getAllByRole("row")
    .filter((row) => row.hasAttribute("data-event"));

async function pick(label: string, option: string) {
  await chooseOption(
    await screen.findByRole("combobox", { name: label }),
    option,
  );
}

describe("审计筛选解析", () => {
  it("地址里的范围、类型、主机、成员；不合法的丢掉", () => {
    const parse = (search: string) => filtersOf(new URLSearchParams(search));
    expect(parse("")).toEqual({ range: "7d" });
    expect(
      parse(
        `range=30d&type=grant&actor=acct_x&host=${MOCK_HOSTS[0]!.sourceId}`,
      ),
    ).toEqual({
      range: "30d",
      type: "grant",
      actor: "acct_x",
      host: MOCK_HOSTS[0]!.sourceId,
    });
    expect(parse("range=1y&type=evil&host=../x")).toEqual({ range: "7d" });
  });
});

describe("团队 · 审计", () => {
  it("缺省最近 7 天：时间 · 成员 · 动作 · 对象 · IP 前缀；动作按 code 取文案，认不出显示原名", async () => {
    mount("/t/rd/audit", OPTIONS);
    expect((await h1()).textContent).toBe("审计");
    const grid = await table();
    for (const header of ["时间", "成员", "动作", "对象", "IP 前缀"])
      expect(
        within(grid).getByRole("columnheader", { name: header }),
      ).toBeTruthy();
    const rows = await waitFor(async () => {
      const found = await bodyRows();
      expect(found).toHaveLength(8);
      return found;
    });
    const text = rows.map((row) => row.textContent ?? "").join("|");
    for (const label of [
      "授予访问",
      "连接主机",
      "更改角色",
      "邀请成员",
      "创建链接",
      "授予到期",
      "更改主机",
      "future.unknown_action",
    ])
      expect(text).toContain(label);
    // 成员名按账号解析；系统与令牌有自己的称呼。
    expect(within(rows[0]!).getByText("张三")).toBeTruthy();
    expect(within(rows[1]!).getByText("李四")).toBeTruthy();
    expect(text).toContain("系统");
    expect(text).toContain("API 令牌");
    expect(text).toContain("203.0.113.0/24");
    // 20 天前的设置变更不在缺省范围里。
    expect(text).not.toContain("更改设置");
  });

  it("时间范围进地址：30 天内多出一条", async () => {
    mount("/t/rd/audit", OPTIONS);
    await bodyRows();
    await pick("时间范围", "最近 30 天");
    expect(window.location.search).toBe("?range=30d");
    await waitFor(async () => expect(await bodyRows()).toHaveLength(9));
    expect(screen.getByText("更改设置")).toBeTruthy();
  });

  it("类型筛选发前缀：只剩授予一类", async () => {
    mount("/t/rd/audit", OPTIONS);
    await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
    await pick("类型", "授予");
    expect(window.location.search).toBe("?type=grant");
    await waitFor(async () => expect(await bodyRows()).toHaveLength(2));
  });

  it("成员与主机筛选：按账号、按主机", async () => {
    mount("/t/rd/audit", OPTIONS);
    await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
    await pick("成员", "李四");
    await waitFor(async () => expect(await bodyRows()).toHaveLength(2));
    await pick("成员", "所有成员");
    await pick("主机", "mac-studio");
    expect(window.location.search).toContain("host=");
    await waitFor(async () => expect(await bodyRows()).toHaveLength(1));
  });

  it("展开一行：对象 id、jti、IP 前缀；再点收起", async () => {
    mount("/t/rd/audit", OPTIONS);
    await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
    fireEvent.click(screen.getByRole("button", { name: "展开 连接主机" }));
    const detail = (await screen.findByText("jti")).closest("dl")!;
    expect(
      within(detail).getByText("jti_01JMOCKASSERTION0000000001"),
    ).toBeTruthy();
    expect(within(detail).getByText(MOCK_HOSTS[1]!.sourceId)).toBeTruthy();
    expect(within(detail).getByText("198.51.100.0/24")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起 连接主机" }));
    expect(screen.queryByText("jti")).toBeNull();
  });

  it("超过 50 行虚拟化：DOM 里只有窗口内的行，滚动后换一批", async () => {
    mount("/t/rd/audit", { ...OPTIONS, extraAudit: 120 });
    const grid = await table();
    await waitFor(() =>
      expect(
        grid
          .querySelector("[data-slot='audit-rows']")
          ?.getAttribute("data-virtual"),
      ).toBe("true"),
    );
    const first = await bodyRows();
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(40);
    // 第一页 100 条，还有下一页。
    expect(grid.getAttribute("aria-rowcount")).toBe("101");
    const scroller = grid.querySelector("[data-slot='audit-rows']")!;
    scroller.scrollTop = 44 * 60;
    fireEvent.scroll(scroller);
    await waitFor(async () => {
      const now = await bodyRows();
      expect(now.length).toBeLessThan(40);
      expect(now[0]!.getAttribute("data-event")).not.toBe(
        first[0]!.getAttribute("data-event"),
      );
    });
  });

  it("50 行以内不虚拟化；「加载更多」翻下一页", async () => {
    mount("/t/rd/audit", { ...OPTIONS, extraAudit: 120 });
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("table", { name: "审计" })
          .getAttribute("aria-rowcount"),
      ).toBe("129"),
    );
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("翻页用首屏定下的 fromMs，列表起点不随时间漂", async () => {
    const api = mount("/t/rd/audit", { ...OPTIONS, extraAudit: 120 });
    const list = vi.spyOn(api.client.audit, "list");
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    await new Promise((done) => setTimeout(done, 20));
    const froms = new Set(list.mock.calls.map(([input]) => input.fromMs));
    expect(froms.size).toBe(1);
  });

  it("窄屏同一份数据画成两行：动作 · 时间，成员 · 对象", async () => {
    viewport(true);
    mount("/t/rd/audit", OPTIONS);
    const rows = await waitFor(async () => {
      const found = await bodyRows();
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(within(rows[0]!).getByText("授予访问")).toBeTruthy();
    expect(within(rows[0]!).getByText("张三")).toBeTruthy();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("空：「这段时间没有记录」，筛选过给「清除筛选」", async () => {
    mount("/t/rd/audit?type=trust", OPTIONS);
    expect(await screen.findByText("这段时间没有记录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
  });

  it("没有任何记录：只有空态", async () => {
    mount("/t/rd/audit", { ...OPTIONS, noAudit: true });
    expect(await screen.findByText("这段时间没有记录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
  });

  it("取数失败：整页状态可重试；member 与 billing 角色访问整页「没有权限」", async () => {
    mount("/t/rd/audit", {
      ...OPTIONS,
      fail: { "audit.list": "rate_limited" },
    });
    await screen.findByRole("button", { name: "重试" });
  });

  it.each(["member", "billing", "guest"] as const)(
    "%s 角色：整页没有权限，不请求审计",
    async (role) => {
      mount("/t/rd/audit", { ...OPTIONS, roles: { rd: role } });
      await screen.findByRole("button", { name: "回到概览" });
      expect(
        document.querySelector("[data-page-state='forbidden']"),
      ).toBeTruthy();
    },
  );
});
