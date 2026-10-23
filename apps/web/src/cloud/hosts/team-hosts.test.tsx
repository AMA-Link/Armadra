import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseOption, installDomPolyfills } from "../../app/test-harness";
import { MOCK_HOSTS, MOCK_PEOPLE, type MockHost } from "../mock/fixtures";
import { h1, installConsoleHarness, mount, viewport } from "../testkit";

installConsoleHarness();
installDomPolyfills();
afterEach(() => vi.restoreAllMocks());

const BUILD = MOCK_HOSTS[0]!.sourceId;
const STUDIO = MOCK_HOSTS[1]!.sourceId;
const OPTIONS = { emailVerified: true } as const;
const RD = "team_mock_rd";

const bulk = (count: number): MockHost[] =>
  Array.from({ length: count }, (_, index) => ({
    ...MOCK_HOSTS[2]!,
    sourceId: (2000 + index).toString(16).padStart(32, "0"),
    name: `bulk-${String(index).padStart(2, "0")}`,
    owner: false,
    ownerName: "李四",
  }));

/** 打开行尾的 ⋯ 菜单（Radix 的触发器认键盘）。 */
async function openMenu(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

const rowOf = async (name: string) => {
  const table = await screen.findByRole("table", { name: "访问" });
  return within(table).getByText(name).closest("tr")!;
};

describe("团队 · 主机目录", () => {
  it("owner / admin 看全部团队主机：名称带所有者第二行，状态同时有文字；个人主机不在其中", async () => {
    mount("/t/rd/hosts", OPTIONS);
    expect((await h1()).textContent).toBe("主机");
    const table = await screen.findByRole("table", { name: "主机" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent),
    ).toEqual(["build-01张三", "mac-studio李四", "dev-box王五"]);
    expect(within(rows[1]!).getByText("离线")).toBeTruthy();
    expect(within(table).queryByText("laptop")).toBeNull();
  });

  it("状态与搜索进地址，游标分页用「加载更多」", async () => {
    mount("/t/rd/hosts?status=online&q=dev", OPTIONS);
    const table = await screen.findByRole("table", { name: "主机" });
    expect(within(table).getByText("dev-box")).toBeTruthy();
    expect(within(table).queryByText("build-01")).toBeNull();

    mount("/t/rd/hosts", { ...OPTIONS, extraHosts: bulk(60) });
    expect(await screen.findByText("bulk-46")).toBeTruthy();
    expect(screen.queryByText("bulk-59")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("bulk-59")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("管理员能重命名 / 撤销别人登记的主机，member 对别人的主机没有这些动作", async () => {
    mount("/t/rd/hosts", OPTIONS);
    await screen.findByRole("table", { name: "主机" });
    await openMenu("mac-studio 的操作");
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "撤销主机" })).toBeTruthy();
  });

  it("member 只看自己登记的与被授予的主机，看不到别人的", async () => {
    mount("/t/rd/hosts", { ...OPTIONS, roles: { rd: "member" } });
    const table = await screen.findByRole("table", { name: "主机" });
    expect(within(table).getByText("build-01")).toBeTruthy();
    expect(within(table).getByText("dev-box")).toBeTruthy();
    expect(within(table).queryByText("mac-studio")).toBeNull();
    // 别人的主机：菜单里只有「打开」，没有重命名与撤销。
    await openMenu("dev-box 的操作").catch(() => undefined);
    expect(screen.queryByRole("menuitem", { name: "撤销主机" })).toBeNull();
  });

  it("窄屏同一份列定义画成 Item", async () => {
    viewport(true);
    mount("/t/rd/hosts", OPTIONS);
    const list = await screen.findByRole("list", { name: "主机" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("没有主机：空态给「登记主机」；筛选为空写出查询词", async () => {
    mount("/t/rd/hosts", { ...OPTIONS, hosts: [] });
    const empty = await screen.findByText("还没有主机");
    expect(
      within(empty.closest("[data-state-kind=empty]") as HTMLElement).getByRole(
        "button",
        { name: "登记主机" },
      ),
    ).toBeTruthy();
  });
});

describe("登记主机：角色与团队开关", () => {
  const registerButton = () =>
    screen.queryByRole("button", { name: "登记主机" });

  it("owner / admin 总有；member 看团队设置；guest 没有", async () => {
    mount("/t/rd/hosts", OPTIONS);
    expect(
      await screen.findByRole("button", { name: "登记主机" }),
    ).toBeTruthy();
  });

  it("member 在团队不允许时没有按钮，允许时有", async () => {
    mount("/t/rd/hosts", { ...OPTIONS, roles: { rd: "member" } });
    await screen.findByRole("table", { name: "主机" });
    expect(registerButton()).toBeNull();
  });

  it("团队允许成员登记：member 有按钮", async () => {
    mount("/t/rd/hosts", {
      ...OPTIONS,
      roles: { rd: "member" },
      settings: { membersCanRegisterHosts: true },
    });
    expect(
      await screen.findByRole("button", { name: "登记主机" }),
    ).toBeTruthy();
  });

  it("guest 没有按钮，只见被授予的主机", async () => {
    mount("/t/rd/hosts", { ...OPTIONS, roles: { rd: "guest" } });
    await screen.findByRole("table", { name: "主机" });
    expect(registerButton()).toBeNull();
  });

  it("billing 到不了主机目录（没有权限）", async () => {
    mount("/t/rd/hosts", { ...OPTIONS, roles: { rd: "billing" } });
    expect(await h1()).toBeTruthy();
    expect(screen.queryByRole("table", { name: "主机" })).toBeNull();
    expect(registerButton()).toBeNull();
  });
});

describe("登记对话框", () => {
  it("取令牌；「在 Armadra 里登记」是只带 issuer 的深链；服务器页签给令牌与可复制的命令", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    mount("/t/rd/hosts", OPTIONS);
    fireEvent.click(await screen.findByRole("button", { name: "登记主机" }));
    const dialog = await screen.findByRole("dialog", { name: "登记主机" });
    const link = await within(dialog).findByRole("link", {
      name: "在 Armadra 里登记",
    });
    expect(link.getAttribute("href")).toBe(
      `armadra://cloud?issuer=${encodeURIComponent("https://app.armadra.test")}`,
    );
    fireEvent.mouseDown(within(dialog).getByRole("tab", { name: "服务器" }), {
      button: 0,
    });
    fireEvent.click(within(dialog).getByRole("tab", { name: "服务器" }));
    const token = (await within(dialog).findByLabelText(
      "注册令牌",
    )) as HTMLInputElement;
    expect(token.value).toBe("armadra-reg-mock-1");
    expect(within(dialog).getByText("10 分钟内有效")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "能进终端的成员可以用这台电脑的系统账号执行命令",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "复制命令" }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        "ARMADRA_CLOUD_REGISTRATION_TOKEN=armadra-reg-mock-1 armadra-server cloud register --issuer https://app.armadra.test",
      ),
    );
  });

  it("失败按 code 取文案：团队不允许成员登记、邮箱未验证（给重新发送）、主机数到上限（给用量入口）", async () => {
    mount("/t/rd/hosts", {
      ...OPTIONS,
      fail: { "sources.registrationToken": "host_registration_disabled" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "登记主机" }));
    expect(
      await screen.findByText("团队不允许成员登记主机，联系管理员"),
    ).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("邮箱未验证：文案加「重新发送验证邮件」", async () => {
    mount("/t/rd/hosts");
    fireEvent.click(await screen.findByRole("button", { name: "登记主机" }));
    const dialog = await screen.findByRole("dialog", { name: "登记主机" });
    expect(await within(dialog).findByText("先验证邮箱再继续")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "重新发送验证邮件" }),
    ).toBeTruthy();
  });

  it("主机数到上限：给「用量与计划」入口", async () => {
    mount("/t/rd/hosts", {
      ...OPTIONS,
      fail: { "sources.registrationToken": "limit_reached" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "登记主机" }));
    const dialog = await screen.findByRole("dialog", { name: "登记主机" });
    expect(
      await within(dialog).findByText("主机数已达上限，升级或撤销一台主机"),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: "用量与计划" })
        .getAttribute("href"),
    ).toBe("/t/rd/billing");
  });
});

describe("团队 · 主机详情", () => {
  it("三页签：访问 · 链接 · 设置，?tab= 进地址；页头带状态与所有者", async () => {
    mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    expect((await h1()).textContent).toBe("build-01");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "访问",
      "链接",
      "设置",
    ]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "链接" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("tab", { name: "链接" }));
    await waitFor(() => expect(window.location.search).toBe("?tab=links"));
    expect(await screen.findByText("For Bob")).toBeTruthy();
  });

  it("member 看别人的主机没有页签；自己的主机有", async () => {
    mount(`/t/rd/hosts/${MOCK_HOSTS[2]!.sourceId}`, {
      ...OPTIONS,
      roles: { rd: "member" },
    });
    expect((await h1()).textContent).toBe("dev-box");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("member 的自己的主机：访问与设置页签都在", async () => {
    mount(`/t/rd/hosts/${BUILD}`, { ...OPTIONS, roles: { rd: "member" } });
    await h1();
    expect((await screen.findAllByRole("tab")).length).toBe(3);
  });

  it("看不到的主机（member 看别人没授予的）：找不到", async () => {
    mount(`/t/rd/hosts/${STUDIO}`, { ...OPTIONS, roles: { rd: "member" } });
    expect(await screen.findByText("找不到这个页面")).toBeTruthy();
  });
});

describe("团队 · 主机详情 · 访问", () => {
  it("每个人一行取合成后的最高权限；团队全员在最前；所有者行没有动作", async () => {
    mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    const table = await screen.findByRole("table", { name: "访问" });
    await within(table).findByText("王五");
    const rows = within(table).getAllByRole("row").slice(1);
    // 名字在 translate="no" 的 span 里；头像首字不算。
    const names = rows.map(
      (row) => row.querySelector("[translate]")?.textContent ?? "",
    );
    expect(names[0]).toBe("团队全员");
    expect(names).toEqual(
      expect.arrayContaining(["张三", "李四", "王五", "赵六"]),
    );
    const cells = (name: string) =>
      within(rows[names.findIndex((entry) => entry === name)]!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells("团队全员").slice(1, 4)).toEqual(["只读", "整台", "直接授予"]);
    expect(cells("张三").slice(1, 4)).toEqual(["可接管", "整台", "所有者"]);
    expect(cells("李四")[3]).toBe("直接授予");
    expect(cells("赵六").slice(1, 3)).toEqual(["可编辑", "2 个工作空间"]);
    expect(screen.queryByRole("button", { name: "张三 的操作" })).toBeNull();
    expect(screen.getByRole("button", { name: "李四 的操作" })).toBeTruthy();
  });

  it("有效权限展开：合成降级的来源两条，较高的那条标「已降低」", async () => {
    mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    const row = await rowOf("王五");
    // 行里就带「已降低」：王五的 driver 被团队全员的只读整台压成只读。
    expect(within(row).getByText("已降低")).toBeTruthy();
    expect(within(row).getAllByRole("cell")[1]!.textContent).toContain("只读");
    fireEvent.click(
      within(row).getByRole("button", { name: "展开 王五 的权限来源" }),
    );
    const sources = await screen.findByRole("list", {
      name: "王五 的权限来源",
    });
    const items = within(sources).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("团队全员");
    expect(items[0]!.textContent).toContain("只读");
    expect(items[0]!.textContent).not.toContain("已降低");
    expect(items[1]!.textContent).toContain("直接授予");
    expect(items[1]!.textContent).toContain("可接管");
    expect(items[1]!.textContent).toContain("1 个工作空间");
    expect(items[1]!.textContent).toContain("已降低");
    // 每条来源各自可撤销。
    expect(
      within(items[1]!).getByRole("button", { name: /撤销 王五/ }),
    ).toBeTruthy();
  });

  it("撤销来源后重新合成：撤掉直接授予，行不再「已降低」", async () => {
    mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    const row = await rowOf("王五");
    fireEvent.click(
      within(row).getByRole("button", { name: "展开 王五 的权限来源" }),
    );
    const sources = await screen.findByRole("list", {
      name: "王五 的权限来源",
    });
    fireEvent.click(
      within(within(sources).getAllByRole("listitem")[1]!).getByRole("button", {
        name: /撤销 王五/,
      }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("撤销 王五 对 build-01 的访问？"),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "撤销访问" }));
    await waitFor(() => {
      const fresh = screen
        .getAllByRole("row")
        .find((r) => r.textContent?.includes("王五"));
      expect(fresh?.textContent).not.toContain("已降低");
    });
  });

  it("撤销即时反映：别处撤销后收到 grantChanged，这一页不用操作就更新；再收到 accessRevoked 也一样", async () => {
    const api = mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    const row = await rowOf("李四");
    expect(row).toBeTruthy();
    const { grants } = await api.client.grants.list({
      sourceId: BUILD,
      accountId: MOCK_PEOPLE.owner.accountId,
    });
    // 另一位管理员在别处撤销了李四的授予。
    await api.client.grants.revoke({ grantId: grants[0]!.grantId });
    await act(async () =>
      api.emit({
        type: "grantChanged",
        sourceId: BUILD,
        grantId: grants[0]!.grantId,
        teamId: RD,
        atMs: Date.now(),
      }),
    );
    // 李四还在团队全员的授予里：行还在，但来源变成团队全员。
    await waitFor(async () => {
      const fresh = await rowOf("李四");
      expect(within(fresh).getAllByRole("cell")[3]!.textContent).toBe(
        "团队全员",
      );
    });
    // 撤掉赵六（只有他本人的授予）：整行消失。
    await api.client.sources.accessRevoke({
      sourceId: BUILD,
      accountId: MOCK_PEOPLE.guest.accountId,
    });
    await act(async () => api.emit({ type: "accessRevoked", sourceId: BUILD }));
    await waitFor(() => {
      const table = screen.getByRole("table", { name: "访问" });
      expect(within(table).queryByText("赵六")).toBeNull();
    });
  });

  it("行里「撤销访问」：确认后撤掉他本人的授予；只有团队授予的人没有这一项", async () => {
    mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    await rowOf("赵六");
    await openMenu("赵六 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤销访问" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "撤销访问" }));
    await waitFor(() => {
      const table = screen.getByRole("table", { name: "访问" });
      expect(within(table).queryByText("赵六")).toBeNull();
    });
  });

  it("导出：本地拼 CSV 下载，列与当前清单一致，不调接口", async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:csv";
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    const api = mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    await rowOf("王五");
    const spy = vi.spyOn(api.client.grants, "list");
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(clicked).toEqual(["build-01-access.csv"]);
    expect(spy).not.toHaveBeenCalled();
    const text = await blobs[0]!.text();
    const lines = text.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("成员,邮箱,权限,范围,来源,到期");
    expect(lines[1]!.startsWith("团队全员,,只读,整台,直接授予")).toBe(true);
    expect(
      lines.some((line) =>
        line.startsWith("王五,wangwu@example.com,只读,整台,直接授予"),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.startsWith(
          "赵六,zhaoliu@example.com,可编辑,2 个工作空间,直接授予,",
        ),
      ),
    ).toBe(true);
  });
});

describe("团队 · 主机详情 · 授予的增改", () => {
  const pick = async (label: string, option: RegExp | string) => {
    fireEvent.click(await screen.findByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name: option }));
  };

  it("添加访问：选成员、权限、到期，授予后清单里多一行", async () => {
    mount(`/t/rd/hosts/${STUDIO}`, OPTIONS);
    await screen.findByText("还没有人有访问权限").catch(() => undefined);
    fireEvent.click(await screen.findByRole("button", { name: "添加访问" }));
    const dialog = await screen.findByRole("dialog", { name: "添加访问" });
    await pick("对象", /王五/);
    fireEvent.click(within(dialog).getByRole("radio", { name: "可编辑" }));
    await chooseOption(
      within(dialog).getByRole("combobox", { name: "到期" }),
      "7 天",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "授予" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const row = await rowOf("王五");
    expect(within(row).getAllByRole("cell")[1]!.textContent).toBe("可编辑");
    expect(within(row).getAllByRole("cell")[2]!.textContent).toBe("整台");
    expect(within(row).getAllByRole("cell")[3]!.textContent).toBe("直接授予");
  });

  it("对象已有授予：按钮是「更新」，改的是原来那条（不再 create，避免 409）", async () => {
    const api = mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    await rowOf("李四");
    const create = vi.spyOn(api.client.grants, "create");
    await openMenu("李四 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "改权限" }));
    const dialog = await screen.findByRole("dialog", {
      name: "改 李四 的权限",
    });
    await waitFor(() =>
      expect(
        (
          within(dialog).getByRole("radio", { name: "可执行" }) as HTMLElement
        ).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: "可编辑" }));
    // 角色降低：提示并改成「仍然更新」。
    expect(
      await within(dialog).findByText(
        "会降低 李四 的权限，他们已有的连接会断开",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "仍然更新" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).not.toHaveBeenCalled();
    const row = await rowOf("李四");
    expect(within(row).getAllByRole("cell")[1]!.textContent).toBe("可编辑");
  });

  it("升角色不提示；提示只在会收窄时出现", async () => {
    mount(`/t/rd/hosts/${BUILD}`, OPTIONS);
    await rowOf("李四");
    await openMenu("李四 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "改权限" }));
    const dialog = await screen.findByRole("dialog", {
      name: "改 李四 的权限",
    });
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("radio", { name: "可执行" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: "可接管" }));
    expect(within(dialog).queryByText(/会降低/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("合成降级：给团队全员加只读整台，提示会降低有访问范围的成员，确认后授予", async () => {
    // mac-studio 上先给王五单独 driver（限在工作空间不能由控制台建，这里直接用 API 种下）。
    const api = mount(`/t/rd/hosts/${STUDIO}`, OPTIONS);
    await api.client.grants.create({
      sourceId: STUDIO,
      subject: { kind: "member", accountId: MOCK_PEOPLE.member.accountId },
      role: "driver",
      workspaceIds: ["ws_mock_api"],
    });
    await screen.findByText("王五");
    fireEvent.click(await screen.findByRole("button", { name: "添加访问" }));
    const dialog = await screen.findByRole("dialog", { name: "添加访问" });
    await pick("对象", "团队全员");
    await within(dialog).findByRole("radio", { name: "只读" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "只读" }));
    expect(
      await within(dialog).findByText(
        "会降低 王五 的权限，他们已有的连接会断开",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "仍然授予" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.narrowedAccess()).toContainEqual({
      sourceId: STUDIO,
      accountId: MOCK_PEOPLE.member.accountId,
    });
    const row = await rowOf("王五");
    expect(within(row).getByText("已降低")).toBeTruthy();
  });

  it("授予失败按 code 取文案：团队关了访客以外的拒绝（邮箱未验证）", async () => {
    mount(`/t/rd/hosts/${STUDIO}`);
    fireEvent.click(await screen.findByRole("button", { name: "添加访问" }));
    const dialog = await screen.findByRole("dialog", { name: "添加访问" });
    await pick("对象", /王五/);
    fireEvent.click(within(dialog).getByRole("button", { name: "授予" }));
    expect(await screen.findByText("先验证邮箱再继续")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "添加访问" })).toBeTruthy();
  });
});

describe("团队 · 主机详情 · 设置", () => {
  it("谁可以创建链接 / 允许访客 / 缺省角色：改动即存，刷新后仍在", async () => {
    mount(`/t/rd/hosts/${BUILD}?tab=settings`, OPTIONS);
    const guests = await screen.findByRole("switch", { name: "允许访客" });
    expect(guests.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(guests);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "允许访客" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    await chooseOption(
      screen.getByRole("combobox", { name: "谁可以创建链接" }),
      "所有者",
    );
    await chooseOption(
      screen.getByRole("combobox", { name: "缺省角色" }),
      "可编辑",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "缺省角色" }).textContent,
      ).toBe("可编辑"),
    );
    expect(screen.getByRole("button", { name: "撤销主机" })).toBeTruthy();
  });

  it("设置保存失败：回滚并提示", async () => {
    mount(`/t/rd/hosts/${BUILD}?tab=settings`, {
      ...OPTIONS,
      fail: { "sources.update": "team_role_insufficient" },
    });
    const guests = await screen.findByRole("switch", { name: "允许访客" });
    fireEvent.click(guests);
    expect(
      await screen.findByText("你的角色不能做这件事，联系团队管理员"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "允许访客" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("撤销主机：输入主机名确认，成功回目录", async () => {
    mount(`/t/rd/hosts/${BUILD}?tab=settings`, OPTIONS);
    fireEvent.click(await screen.findByRole("button", { name: "撤销主机" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.change(within(confirm).getByLabelText("输入 build-01 确认"), {
      target: { value: "build-01" },
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "撤销主机" }));
    await waitFor(() => expect(window.location.pathname).toBe("/t/rd/hosts"));
  });
});
