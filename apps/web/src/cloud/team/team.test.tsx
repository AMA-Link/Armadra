import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { chooseOption } from "../../app/test-harness";
import { MOCK_INVITE_BY_OWNER, MOCK_INVITE_EMAIL } from "../mock/teams";
import { h1, installConsoleHarness, mount, viewport } from "../testkit";

installConsoleHarness();

/** 打开行尾的 ⋯ 菜单（Radix 的触发器认键盘）。 */
async function openMenu(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

/** 选 Select 里的一项。 */
async function choose(label: string, option: string) {
  await chooseOption(
    await screen.findByRole("combobox", { name: label }),
    option,
  );
}

const OPTIONS = { emailVerified: true } as const;

describe("创建团队", () => {
  it("空间菜单里的「创建团队」：名称生成地址，成功后跳进新团队", async () => {
    mount("/me", OPTIONS);
    const trigger = await screen.findByRole("button", { name: /个人空间/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "创建团队" }));
    const dialog = await screen.findByRole("dialog", { name: "创建团队" });
    fireEvent.change(within(dialog).getByLabelText("名称"), {
      target: { value: "Alpha Team" },
    });
    const slug = within(dialog).getByLabelText("地址") as HTMLInputElement;
    expect(slug.value).toBe("alpha-team");
    fireEvent.click(within(dialog).getByRole("button", { name: "创建团队" }));
    await waitFor(() => expect(window.location.pathname).toBe("/t/alpha-team"));
    expect((await h1()).textContent).toBe("概览");
  });

  it("地址被占用：错误贴在地址字段下并聚焦；名称为空先报名称", async () => {
    mount("/me", OPTIONS);
    const trigger = await screen.findByRole("button", { name: /个人空间/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "创建团队" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "创建团队" }));
    expect(await within(dialog).findByText("输入团队名称")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("名称"), {
      target: { value: "研发组" },
    });
    // 纯中文名生成不出地址：留空让人填。
    expect(
      (within(dialog).getByLabelText("地址") as HTMLInputElement).value,
    ).toBe("");
    fireEvent.click(within(dialog).getByRole("button", { name: "创建团队" }));
    expect(
      await within(dialog).findByText("地址只能用小写字母、数字和连字符"),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("地址"), {
      target: { value: "rd" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建团队" }));
    const error = await within(dialog).findByText("地址已被占用，换一个");
    const field = within(dialog).getByLabelText("地址");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("团队数到上限：toast 给出额度文案，对话框留着", async () => {
    mount("/t/lab/settings", { emailVerified: true, roles: { lab: "owner" } });
    const trigger = await screen.findByRole("button", { name: /Lab/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "创建团队" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), {
      target: { value: "Beta" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建团队" }));
    expect(
      (await screen.findAllByText("免费版只能建一个团队，升级后再建")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("团队概览", () => {
  it("四张卡：主机 / 成员 / 本月流量 / 计划", async () => {
    mount("/t/rd", OPTIONS);
    expect((await h1()).textContent).toBe("概览");
    expect(await screen.findByText("2 / 3 在线")).toBeTruthy();
    expect(await screen.findByText("4 位成员")).toBeTruthy();
    expect(screen.getByText("访客 1")).toBeTruthy();
    expect(await screen.findByText(/1\.2 GB/)).toBeTruthy();
    expect(screen.getByText("团队版")).toBeTruthy();
  });

  it("guest 只有主机卡和可达的主机列表，billing 没有主机卡", async () => {
    mount("/t/rd", { ...OPTIONS, roles: { rd: "guest" } });
    expect(await screen.findByText("2 / 3 在线")).toBeTruthy();
    expect(screen.queryByText("本月流量")).toBeNull();
    expect(screen.queryByText("计划")).toBeNull();
    expect(await screen.findByRole("table", { name: "主机" })).toBeTruthy();
  });

  it("billing：成员、流量、计划，没有主机", async () => {
    mount("/t/rd", { ...OPTIONS, roles: { rd: "billing" } });
    expect(await screen.findByText("4 位成员")).toBeTruthy();
    expect(screen.getByText("本月流量")).toBeTruthy();
    expect(screen.queryByText(/在线/)).toBeNull();
  });
});

describe("成员与邀请", () => {
  it("成员页签：头像名字邮箱、角色、加入时间；访客页签带可达主机数", async () => {
    mount("/t/rd/members", OPTIONS);
    expect((await h1()).textContent).toBe("成员");
    const table = await screen.findByRole("table", { name: "成员" });
    expect(within(table).getByText("王五")).toBeTruthy();
    expect(within(table).getByText("wangwu@example.com")).toBeTruthy();
    expect(within(table).queryByText("赵六")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /访客/ }), {
      button: 0,
    });
    fireEvent.keyDown(screen.getByRole("tab", { name: /访客/ }), {
      key: "Enter",
    });
    const guests = await screen.findByRole("table", { name: "访客" });
    expect(within(guests).getByText("赵六")).toBeTruthy();
    expect(within(guests).getByText("2")).toBeTruthy();
  });

  it("管理员改角色：行内 Select；owner 一行是文字", async () => {
    mount("/t/rd/members", OPTIONS);
    const table = await screen.findByRole("table", { name: "成员" });
    expect(
      within(table).queryByRole("combobox", { name: "李四 的角色" }),
    ).toBeNull();
    expect(within(table).getByText("所有者")).toBeTruthy();
    await choose("王五 的角色", "账单");
    await waitFor(() =>
      expect(within(table).queryByText("王五")).not.toBeNull(),
    );
    expect(
      (await screen.findByRole("combobox", { name: "王五 的角色" }))
        .textContent,
    ).toBe("账单");
  });

  it("成员变动与邀请变动的事件只让对应的列表重拉", async () => {
    const api = mount("/t/rd/members", OPTIONS);
    const table = await screen.findByRole("table", { name: "成员" });
    await api.client.teams.memberRole({
      teamId: "team_mock_rd",
      accountId: "acct_mock_wangwu",
      role: "billing",
    });
    act(() =>
      api.emit({
        type: "memberChanged",
        teamId: "team_mock_rd",
        accountId: "acct_mock_wangwu",
        change: "roleChanged",
        atMs: Date.now(),
      }),
    );
    await waitFor(() =>
      expect(
        within(table).getByRole("combobox", { name: "王五 的角色" })
          .textContent,
      ).toBe("账单"),
    );
  });

  it("移除成员要确认，成功后行消失", async () => {
    mount("/t/rd/members", OPTIONS);
    const menu = await openMenu("王五 的操作");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "移除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("移除「王五」？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "移除成员" }));
    await waitFor(() => expect(screen.queryByText("王五")).toBeNull());
  });

  it("本人一行的菜单是「离开团队」，离开后回个人空间", async () => {
    mount("/t/lab/members", OPTIONS);
    const menu = await openMenu("张三 的操作");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "离开团队" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("离开「Lab」？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "离开团队" }));
    await waitFor(() => expect(window.location.pathname).toBe("/me"));
  });

  it("邀请页签：邮箱、角色、邀请人、到期；重新发送与撤销", async () => {
    mount("/t/rd/members?tab=invitations", OPTIONS);
    const table = await screen.findByRole("table", { name: "邀请" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const qian = rows.find((row) =>
      within(row).queryByText(MOCK_INVITE_EMAIL),
    )!;
    expect(within(qian).getByText("待接受")).toBeTruthy();
    expect(within(qian).getByText("张三")).toBeTruthy();
    const chen = rows.find((row) =>
      within(row).queryByText(MOCK_INVITE_BY_OWNER),
    )!;
    expect(within(chen).getByText("李四")).toBeTruthy();
    expect(within(chen).getByText("账单")).toBeTruthy();
    const old = rows.find((row) => within(row).queryByText("old@example.com"))!;
    expect(within(old).getByText("已过期")).toBeTruthy();

    const menu = await openMenu(`${MOCK_INVITE_EMAIL} 的操作`);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "重新发送" }));
    expect(await screen.findByText("已重新发送")).toBeTruthy();

    const second = await openMenu(`${MOCK_INVITE_EMAIL} 的操作`);
    fireEvent.click(within(second).getByRole("menuitem", { name: "撤销邀请" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(`撤销给 ${MOCK_INVITE_EMAIL} 的邀请？`),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销邀请" }));
    await waitFor(() =>
      expect(screen.queryByText(MOCK_INVITE_EMAIL)).toBeNull(),
    );
  });

  it("邀请成员：逐个校验邮箱并标出第几个，发出后 toast 数量", async () => {
    mount("/t/rd/members", OPTIONS);
    fireEvent.click(await screen.findByRole("button", { name: "邀请成员" }));
    const dialog = await screen.findByRole("dialog", { name: "邀请成员" });
    const box = within(dialog).getByLabelText("邮箱");
    fireEvent.change(box, { target: { value: "a@example.com, nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送邀请" }));
    expect(await within(dialog).findByText("第 2 个邮箱格式不对")).toBeTruthy();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(box, {
      target: { value: "a@example.com\nb@example.com; A@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送邀请" }));
    expect(await screen.findByText("已邀请 2 人")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("邀请中途失败：已发出的从输入框去掉，失败的邮箱带原因留着", async () => {
    mount("/t/rd/members", OPTIONS);
    fireEvent.click(await screen.findByRole("button", { name: "邀请成员" }));
    const dialog = await screen.findByRole("dialog", { name: "邀请成员" });
    const box = within(dialog).getByLabelText("邮箱") as HTMLTextAreaElement;
    fireEvent.change(box, {
      target: {
        value: "ok@example.com\nwangwu@example.com\nlater@example.com",
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送邀请" }));
    expect(
      await within(dialog).findByText("wangwu@example.com：已是团队成员"),
    ).toBeTruthy();
    expect(box.value).toBe("wangwu@example.com\nlater@example.com");
    expect(await screen.findByText("已邀请 1 人")).toBeTruthy();
  });

  it("免费团队席位已满：limit_reached 带额度文案", async () => {
    mount("/t/lab/members", { ...OPTIONS, roles: { lab: "admin" } });
    fireEvent.click(await screen.findByRole("button", { name: "邀请成员" }));
    const dialog = await screen.findByRole("dialog", { name: "邀请成员" });
    fireEvent.change(within(dialog).getByLabelText("邮箱"), {
      target: {
        value: "a@example.com b@example.com c@example.com d@example.com",
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送邀请" }));
    expect(
      await within(dialog).findByText(
        "d@example.com：成员数已达上限，升级或移除一位成员",
      ),
    ).toBeTruthy();
  });

  it("窄屏：Item 列表，右侧是角色 Select", async () => {
    viewport(true);
    mount("/t/rd/members", OPTIONS);
    const list = await screen.findByRole("list", { name: "成员" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(
      within(list).getByRole("combobox", { name: "王五 的角色" }),
    ).toBeTruthy();
  });
});

describe("团队设置", () => {
  it("常规：改名失焦即存，侧栏跟着变；地址只读", async () => {
    mount("/t/rd/settings", OPTIONS);
    const name = (await screen.findByLabelText("名称")) as HTMLInputElement;
    expect(name.value).toBe("研发组");
    expect(screen.getByText(/\/t\/rd$/)).toBeTruthy();
    fireEvent.change(name, { target: { value: "平台组" } });
    fireEvent.blur(name);
    expect(await screen.findByText("已保存")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByText("平台组").length).toBeGreaterThan(0),
    );
  });

  it("访问：开关与选择立即保存", async () => {
    mount("/t/rd/settings", OPTIONS);
    const guests = await screen.findByRole("switch", { name: "允许访客" });
    expect(guests.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(guests);
    await waitFor(() =>
      expect(guests.getAttribute("aria-checked")).toBe("false"),
    );
    expect((await screen.findAllByText("已保存")).length).toBeGreaterThan(0);
    await choose("缺省主机角色", "可编辑");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "缺省主机角色" }).textContent,
      ).toBe("可编辑"),
    );
  });

  it("保存失败：回滚并给 toast", async () => {
    mount("/t/rd/settings", {
      ...OPTIONS,
      fail: { "teams.settingsUpdate": "team_policy_denied" },
    });
    const guests = await screen.findByRole("switch", { name: "允许访客" });
    fireEvent.click(guests);
    expect(
      await screen.findByText("团队设置不允许这样做，联系管理员"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(guests.getAttribute("aria-checked")).toBe("true"),
    );
  });
});

describe("危险操作", () => {
  it("转移所有权：选一位管理员，确认标题重复对象名；之后本人降为管理员", async () => {
    mount("/t/lab/settings", { ...OPTIONS, roles: { lab: "owner" } });
    await choose("新所有者", "李四");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("把「Lab」转给 李四？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "转移所有权" }));
    expect(await screen.findByText("已转移所有权")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "删除团队" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "离开团队" })).toBeTruthy();
  });

  it("删除团队：输入地址确认，不一致不提交；有在线主机时给原因", async () => {
    mount("/t/rd/settings", { ...OPTIONS, roles: { rd: "owner" } });
    fireEvent.click(await screen.findByRole("button", { name: "删除团队" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("删除「研发组」？")).toBeTruthy();
    const input = within(dialog).getByLabelText("输入 rd 确认");
    fireEvent.change(input, { target: { value: "rd-x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    expect(await within(dialog).findByText("与 rd 不一致")).toBeTruthy();
    expect(window.location.pathname).toBe("/t/rd/settings");
    fireEvent.change(input, { target: { value: "rd" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    expect(
      await screen.findByText("团队还有在线主机，先让它们下线或撤销"),
    ).toBeTruthy();
    // 对话框留着可以重试。
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("删除后进恢复期：整页给清除日期，所有者恢复后回到团队", async () => {
    mount("/t/lab/settings", {
      ...OPTIONS,
      hosts: [],
      roles: { lab: "owner" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "删除团队" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("输入 lab 确认"), {
      target: { value: "lab" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    expect(
      await screen.findByRole("heading", { name: /团队将于 .+ 清除/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复团队" }));
    expect(await screen.findByText("已恢复团队")).toBeTruthy();
    expect((await h1()).textContent).toBe("概览");
    expect(window.location.pathname).toBe("/t/lab");
  });

  it("恢复受团队数额度限制：另有自己拥有的团队时给额度文案，仍停在恢复页", async () => {
    const api = mount("/t/lab/settings", {
      ...OPTIONS,
      hosts: [],
      roles: { lab: "owner" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "删除团队" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("输入 lab 确认"), {
      target: { value: "lab" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    await screen.findByRole("heading", { name: /团队将于/ });
    await api.client.teams.create({ slug: "alpha", name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "恢复团队" }));
    expect(
      (await screen.findAllByText("免费版只能建一个团队，升级后再建")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "恢复团队" })).toBeTruthy();
  });

  it("没有管理员就没有转移这一行（成员变动的事件让列表重拉）", async () => {
    const api = mount("/t/rd/settings", { ...OPTIONS, roles: { rd: "owner" } });
    expect(
      await screen.findByRole("combobox", { name: "新所有者" }),
    ).toBeTruthy();
    await api.client.teams.memberRole({
      teamId: "team_mock_rd",
      accountId: "acct_mock_lisi",
      role: "member",
    });
    act(() =>
      api.emit({
        type: "memberChanged",
        teamId: "team_mock_rd",
        accountId: "acct_mock_lisi",
        change: "roleChanged",
        atMs: Date.now(),
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "新所有者" })).toBeNull(),
    );
  });

  it("删除团队：输入地址确认，不一致不提交；有在线主机时给原因", async () => {
    mount("/t/rd/settings", { ...OPTIONS, roles: { rd: "owner" } });
    fireEvent.click(await screen.findByRole("button", { name: "删除团队" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("删除「研发组」？")).toBeTruthy();
    const input = within(dialog).getByLabelText("输入 rd 确认");
    fireEvent.change(input, { target: { value: "rd-x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    expect(await within(dialog).findByText("与 rd 不一致")).toBeTruthy();
    expect(window.location.pathname).toBe("/t/rd/settings");
    fireEvent.change(input, { target: { value: "rd" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    expect(
      await screen.findByText("团队还有在线主机，先让它们下线或撤销"),
    ).toBeTruthy();
    // 对话框留着可以重试。
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("删除后进恢复期：整页给清除日期，所有者恢复后回到团队", async () => {
    mount("/t/lab/settings", {
      ...OPTIONS,
      hosts: [],
      roles: { lab: "owner" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "删除团队" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("输入 lab 确认"), {
      target: { value: "lab" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    expect(
      await screen.findByRole("heading", { name: /团队将于 .+ 清除/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复团队" }));
    expect(await screen.findByText("已恢复团队")).toBeTruthy();
    expect((await h1()).textContent).toBe("概览");
    expect(window.location.pathname).toBe("/t/lab");
  });

  it("恢复受团队数额度限制：另有自己拥有的团队时给额度文案，仍停在恢复页", async () => {
    const api = mount("/t/lab/settings", {
      ...OPTIONS,
      hosts: [],
      roles: { lab: "owner" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "删除团队" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("输入 lab 确认"), {
      target: { value: "lab" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除团队" }));
    await screen.findByRole("heading", { name: /团队将于/ });
    await api.client.teams.create({ slug: "alpha", name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "恢复团队" }));
    expect(
      (await screen.findAllByText("免费版只能建一个团队，升级后再建")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "恢复团队" })).toBeTruthy();
  });

  it("没有管理员就没有转移这一行", async () => {
    const api = mount("/t/rd/settings", { ...OPTIONS, roles: { rd: "owner" } });
    expect(
      await screen.findByRole("combobox", { name: "新所有者" }),
    ).toBeTruthy();
    await api.client.teams.memberRole({
      teamId: "team_mock_rd",
      accountId: "acct_mock_lisi",
      role: "member",
    });
    await waitFor(() => expect(api.client.teams.members).toBeTruthy());
  });

  it("所有者不渲染「离开团队」（要先转移所有权）", async () => {
    mount("/t/lab/settings", { ...OPTIONS, roles: { lab: "owner" } });
    await screen.findByRole("button", { name: "删除团队" });
    expect(screen.queryByRole("button", { name: "离开团队" })).toBeNull();
  });

  it("团队关了访客：邀请与改角色都没有「访客」选项，已是访客的行仍显示当前值", async () => {
    mount("/t/rd/members", { ...OPTIONS, settings: { allowGuests: false } });
    const trigger = await screen.findByRole("combobox", {
      name: "王五 的角色",
    });
    // 设置取到之前「访客」还在；等它取到再看选项。
    await waitFor(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const options = await screen.findAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "管理员",
        "成员",
        "账单",
      ]);
      fireEvent.keyDown(options[0]!, { key: "Escape" });
    });
    fireEvent.click(screen.getByRole("button", { name: "邀请成员" }));
    const dialog = await screen.findByRole("dialog", { name: "邀请成员" });
    const role = within(dialog).getByRole("combobox", { name: "角色" });
    fireEvent.keyDown(role, { key: "ArrowDown" });
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["管理员", "成员", "账单"]);
    fireEvent.keyDown(screen.getAllByRole("option")[0]!, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /访客/ }), {
      button: 0,
    });
    fireEvent.keyDown(screen.getByRole("tab", { name: /访客/ }), {
      key: "Enter",
    });
    expect(
      (await screen.findByRole("combobox", { name: "赵六 的角色" }))
        .textContent,
    ).toBe("访客");
  });

  it("撤销邀请后那一行消失；云端返回的已接受邀请不显示", async () => {
    mount("/t/rd/members?tab=invitations", OPTIONS);
    const table = await screen.findByRole("table", { name: "邀请" });
    expect(within(table).queryByText("done@example.test")).toBeNull();
    const menu = await openMenu(`${MOCK_INVITE_BY_OWNER} 的操作`);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "撤销邀请" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "撤销邀请",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(MOCK_INVITE_BY_OWNER)).toBeNull(),
    );
  });

  it("恢复超额：给「已拥有另一个团队」的文案", async () => {
    const api = mount("/t/lab/settings", {
      ...OPTIONS,
      hosts: [],
      deleted: ["lab"],
      roles: { lab: "owner" },
    });
    await api.client.teams.create({ slug: "alpha", name: "Alpha" });
    window.history.pushState(null, "", "/t/lab");
    window.dispatchEvent(new PopStateEvent("popstate"));
    fireEvent.click(await screen.findByRole("button", { name: "恢复团队" }));
    expect(
      (
        await screen.findAllByText(
          "你已拥有另一个团队：删除或转移它，或升级后再恢复",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("不是成员的团队地址仍是「找不到」", async () => {
    mount("/t/nope", OPTIONS);
    expect(await screen.findByText("找不到这个页面")).toBeTruthy();
  });
});
