import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MockHost } from "../mock/fixtures";
import { MOCK_PERSONAL } from "../mock/fixtures";
import { h1, mount, installConsoleHarness, viewport } from "../testkit";

installConsoleHarness();

const LAPTOP = MOCK_PERSONAL.linkHost;

/** 打开行尾的 ⋯ 菜单（Radix 的触发器认键盘）。 */
async function openMenu(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

const extra = (count: number): MockHost[] =>
  Array.from({ length: count }, (_, index) => ({
    sourceId: (1000 + index).toString(16).padStart(32, "0"),
    name: `bulk-${String(index).padStart(2, "0")}`,
    kind: "server",
    online: index % 2 === 0,
    lastSeenAtMs: Date.UTC(2025, 9, 9),
    owner: true,
    ownerName: "张三",
    via: "owner",
    relayOrigin: "https://relay.armadra.test",
    coreVersion: "0.9.3",
  }));

describe("个人 · 主机目录", () => {
  it("表格 5 列：名称、状态、标签、最近在线、动作；只有个人空间的主机", async () => {
    mount("/me/hosts");
    expect((await h1()).textContent).toBe("主机");
    const table = await screen.findByRole("table", { name: "主机" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers).toHaveLength(5);
    expect(headers.slice(0, 4).map((cell) => cell.textContent)).toEqual([
      "名称",
      "状态",
      "标签",
      "最近在线",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent),
    ).toEqual(["nas", "laptop"]);
    // 状态同时有文字；个人空间没有「所有者」第二行。
    expect(within(rows[0]!).getByText("离线")).toBeTruthy();
    expect(within(rows[1]!).getByText("在线")).toBeTruthy();
    expect(within(table).queryByText("张三")).toBeNull();
  });

  it("窄屏同一份列定义画成 Item：名称与状态在第一行，最近在线折进第二行", async () => {
    viewport(true);
    mount("/me/hosts");
    const list = await screen.findByRole("list", { name: "主机" });
    expect(screen.queryByRole("table")).toBeNull();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[1]!).getByText("laptop")).toBeTruthy();
    expect(within(items[1]!).getByText("在线")).toBeTruthy();
    // 窄屏的「打开」收进 ⋯ 菜单。
    expect(within(items[1]!).queryByRole("link", { name: /^打开/ })).toBeNull();
    await openMenu("laptop 的操作");
    expect(
      screen.getByRole("menuitem", { name: "打开" }).getAttribute("href"),
    ).toBe(`/h/${LAPTOP}`);
  });

  it("名称是详情链接，「打开」在新标签打开画布", async () => {
    mount("/me/hosts");
    const link = await screen.findByRole("link", { name: "laptop" });
    expect(link.getAttribute("href")).toBe(`/me/hosts/${LAPTOP}`);
    const open = screen.getByRole("link", { name: "打开 laptop" });
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("href")).toBe(`/h/${LAPTOP}`);
  });

  it("状态与搜索进地址：?status=online 只列在线，?q 无匹配给「清除筛选」", async () => {
    mount("/me/hosts?status=online");
    await screen.findByText("laptop");
    expect(screen.queryByText("nas")).toBeNull();
  });

  it("搜索无匹配：写出查询词，清除筛选回到完整列表", async () => {
    mount("/me/hosts?q=zzz");
    expect(await screen.findByText("没有匹配「zzz」的结果")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByText("nas")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("个人空间没有已撤销的主机：?status=revoked 被丢掉，照常列出", async () => {
    mount("/me/hosts?status=revoked");
    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.getByText("nas")).toBeTruthy();
  });

  it("地址里的搜索词被外部改了（后退），搜索框跟着变", async () => {
    mount("/me/hosts?q=lap");
    const box = (await screen.findByRole("searchbox", {
      name: "搜索主机",
    })) as HTMLInputElement;
    expect(box.value).toBe("lap");
    act(() => {
      window.history.pushState(null, "", "/me/hosts");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(box.value).toBe(""));
    expect(await screen.findByText("nas")).toBeTruthy();
  });

  it("搜索框输入后写进地址并按它筛选", async () => {
    mount("/me/hosts");
    await screen.findByText("nas");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索主机" }), {
      target: { value: "lap" },
    });
    await waitFor(() => expect(window.location.search).toBe("?q=lap"));
    await waitFor(() => expect(screen.queryByText("nas")).toBeNull());
    expect(screen.getByText("laptop")).toBeTruthy();
  });

  it("游标分页：第一页 50 条，「加载更多」接上剩下的", async () => {
    const api = mount("/me/hosts", { extraHosts: extra(60) });
    const list = vi.spyOn(api.client.sources, "list");
    await screen.findByText("bulk-00");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 50);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(screen.getAllByRole("row")).toHaveLength(1 + 62),
    );
    expect(list.mock.calls.at(-1)![0]).toMatchObject({ cursor: "50" });
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("重命名：保存后表里换成新名字", async () => {
    mount("/me/hosts");
    await openMenu("laptop 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), {
      target: { value: "workstation" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("workstation")).toBeTruthy();
    expect(screen.queryByText("laptop")).toBeNull();
  });

  it("撤销主机要输入主机名确认；不一致不发请求，一致后行消失", async () => {
    const api = mount("/me/hosts");
    const revoke = vi.spyOn(api.client.sources, "revoke");
    await openMenu("laptop 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤销主机" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("撤销「laptop」？")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "撤销主机" });
    fireEvent.click(confirm);
    expect(await within(dialog).findByText("与 laptop 不一致")).toBeTruthy();
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("输入 laptop 确认"), {
      target: { value: "laptop" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("laptop")).toBeNull());
    expect(screen.getByText("nas")).toBeTruthy();
  });
});

describe("个人 · 主机目录的五态", () => {
  it("加载：先画骨架", async () => {
    mount("/me/hosts", { latencyMs: 80 });
    await h1();
    expect(document.querySelector("[data-slot='skeleton-table']")).toBeTruthy();
    await screen.findByText("nas");
    expect(document.querySelector("[data-slot='skeleton-table']")).toBeNull();
  });

  it("空：「还没有主机」", async () => {
    mount("/me/hosts", { hosts: [] });
    expect(await screen.findByText("还没有主机")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("错：按错误码出文案，重试再取一次", async () => {
    // 429 不自动重试（5xx 会重试两次，测试里等不起）。
    const api = mount("/me/hosts", {
      fail: { "sources.list": "rate_limited" },
    });
    await screen.findByRole("button", { name: "重试" });
    expect(document.querySelector("[data-page-state='error']")).toBeTruthy();
    const list = vi.spyOn(api.client.sources, "list");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(list).toHaveBeenCalled());
  });

  it("没有权限：整页「没有权限」，回概览", async () => {
    mount("/me/hosts", { fail: { "sources.list": "forbidden" } });
    expect(
      await screen.findByRole("button", { name: "回到概览" }),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-page-state='forbidden']"),
    ).toBeTruthy();
  });
});

describe("个人 · 主机详情", () => {
  it("页头：名称、状态、所有者与版本；页签访问、链接、设置", async () => {
    mount(`/me/hosts/${LAPTOP}`);
    expect((await h1()).textContent).toBe("laptop");
    expect(screen.getByText("在线")).toBeTruthy();
    expect(screen.getByText(/版本 0\.9\.3/)).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "访问",
      "链接",
      "设置",
    ]);
    // 访问页：所有者自己一行（不能撤销）与本人发出的分享。
    expect(await screen.findByText("lisi@example.com")).toBeTruthy();
    expect(
      within(screen.getByRole("table")).getByText("zhangsan@example.com"),
    ).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("所有者")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "撤销 zhangsan@example.com 的访问",
      }),
    ).toBeNull();
  });

  it("?tab=links 只列这台主机的链接，不再画目标列，也不为取名字再列一遍主机", async () => {
    const api = mount(`/me/hosts/${LAPTOP}?tab=links`);
    // 详情页本身不调目录；整个空间的链接页才要靠目录取目标名。
    const list = vi.spyOn(api.client.sources, "list");
    expect(await screen.findByText("给小李看进度")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByRole("columnheader", { name: "目标" })).toBeNull();
  });

  it("撤销访问：确认后那一行消失", async () => {
    mount(`/me/hosts/${LAPTOP}`);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "撤销 lisi@example.com 的访问",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("撤销 lisi@example.com 对 laptop 的访问？"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销访问" }));
    await waitFor(() =>
      expect(screen.queryByText("lisi@example.com")).toBeNull(),
    );
    expect(screen.getByText("wangwu@example.com")).toBeTruthy();
  });

  it("设置页签的撤销主机回到目录", async () => {
    mount(`/me/hosts/${LAPTOP}?tab=settings`);
    fireEvent.click(await screen.findByRole("button", { name: "撤销主机" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("输入 laptop 确认"), {
      target: { value: "laptop" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销主机" }));
    await waitFor(() => expect(window.location.pathname).toBe("/me/hosts"));
  });

  it("不存在的主机：整页找不到", async () => {
    mount("/me/hosts/ffffffffffffffffffffffffffffffff");
    expect(await screen.findByText("找不到这个页面")).toBeTruthy();
  });
});
