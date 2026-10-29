import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CloudConsoleError, describeFailure } from "../api/errors";
import { ConsoleRoot } from "../ConsoleRoot";
import type { HostChannel, HostRequest } from "../host-channel";
import { createMockApi, type MockOptions } from "../mock/create-mock-client";
import { MOCK_HOSTS, MOCK_PERSONAL } from "../mock/fixtures";
import { h1, mount, installConsoleHarness, visit } from "../testkit";

installConsoleHarness();

async function openMenu(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

const typeInto = (label: string, value: string, within_?: HTMLElement) =>
  fireEvent.change(
    within_
      ? within(within_).getByLabelText(label)
      : screen.getByLabelText(label),
    { target: { value } },
  );

describe("个人 · 链接", () => {
  it("列：备注、目标、权限、用量、到期；过期的有徽标，没有备注的显示「未命名链接」", async () => {
    mount("/me/links");
    expect((await h1()).textContent).toBe("链接");
    const table = await screen.findByRole("table", { name: "链接" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("给小李看进度")).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole("link", { name: "laptop" })
        .getAttribute("href"),
    ).toBe(`/me/hosts/${MOCK_PERSONAL.linkHost}`);
    expect(within(rows[0]!).getByText("只读")).toBeTruthy();
    expect(within(rows[0]!).getByText("2 / 5")).toBeTruthy();
    expect(within(rows[0]!).getByText("7 天后到期")).toBeTruthy();
    expect(within(rows[1]!).getByText("未命名链接")).toBeTruthy();
    expect(within(rows[1]!).getByText("可编辑")).toBeTruthy();
    expect(within(rows[1]!).getByText("已过期")).toBeTruthy();
    // 链接地址只在新建时出现一次：列表里没有复制与地址。
    expect(screen.queryByText(/\/j\/link_one/)).toBeNull();
  });

  it("编辑备注：保存后换成新备注", async () => {
    mount("/me/links");
    await openMenu("给小李看进度 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑备注" }));
    const dialog = await screen.findByRole("dialog");
    typeInto("备注", "给小王看进度", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("给小王看进度")).toBeTruthy();
    expect(screen.queryByText("给小李看进度")).toBeNull();
  });

  it("撤销链接：标题带备注、后果一行；确认后这一行变「已撤销」且不能再撤销", async () => {
    const api = mount("/me/links");
    const revoke = vi.spyOn(api.client.links, "revoke");
    await openMenu("给小李看进度 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤销链接" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("撤销「给小李看进度」？")).toBeTruthy();
    expect(within(dialog).getByText("已加入的人一并停用")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销链接" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith({ linkId: "link_one" }),
    );
    expect(await screen.findByText("已撤销")).toBeTruthy();
    await openMenu("给小李看进度 的操作");
    expect(screen.queryByRole("menuitem", { name: "撤销链接" })).toBeNull();
  });

  it("撤销失败：按错误码出文案，对话框留着", async () => {
    mount("/me/links", { fail: { "links.revoke": "forbidden" } });
    await openMenu("给小李看进度 的操作");
    fireEvent.click(screen.getByRole("menuitem", { name: "撤销链接" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销链接" }));
    expect(
      await screen.findByText(
        describeFailure(new CloudConsoleError("forbidden", 403)),
      ),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("空：「没有链接」", async () => {
    mount("/me/links", { without: ["links"] });
    expect(await screen.findByText("没有链接")).toBeTruthy();
  });

  it("加载：先画骨架", async () => {
    mount("/me/links", { latencyMs: 80 });
    await h1();
    expect(document.querySelector("[data-slot='skeleton-table']")).toBeTruthy();
    await screen.findByText("给小李看进度");
  });

  it("错与没有权限：整页状态", async () => {
    mount("/me/links", { fail: { "links.list": "rate_limited" } });
    await screen.findByRole("button", { name: "重试" });
    expect(document.querySelector("[data-page-state='error']")).toBeTruthy();
  });

  it("没有权限：整页「没有权限」", async () => {
    mount("/me/links", { fail: { "links.list": "forbidden" } });
    await screen.findByRole("button", { name: "回到概览" });
    expect(
      document.querySelector("[data-page-state='forbidden']"),
    ).toBeTruthy();
  });
});

// —— 新建链接（设计 saas-host-open §4.3，B5）——

const LAPTOP = MOCK_PERSONAL.linkHost;
const SECRET_URL = () =>
  `${window.location.origin}/j/lnk_new#s3cr3t.inv1tation.0123456789abcdef`;

type Reply = { status?: number; body?: unknown };
const reply = (r: Reply) =>
  ({
    ok: (r.status ?? 200) < 300,
    status: r.status ?? 200,
    headers: new Headers(),
    json: async () => r.body ?? {},
  }) as unknown as Response;

/** 主机源表里的远程服务：个人中转、别的签发方、访客行各一条，只有一条是这个控制台的 SaaS 登录行。 */
const remotes = () => [
  {
    serviceId: "svc_personal",
    kind: "personal",
    issuer: "https://relay.example",
    guest: false,
    registered: true,
  },
  {
    serviceId: "svc_other",
    kind: "saas",
    issuer: "https://app.other.example",
    guest: false,
    registered: true,
  },
  {
    serviceId: "svc_guest",
    kind: "saas",
    issuer: window.location.origin,
    guest: true,
    registered: false,
  },
  {
    serviceId: "svc_console",
    kind: "saas",
    issuer: window.location.origin,
    guest: false,
    registered: true,
  },
];

function fakeChannel(
  options: {
    trusted?: boolean;
    remotes?: () => unknown[];
    create?: () => Reply;
  } = {},
) {
  const calls: { sourceId: string; path: string; init: HostRequest }[] = [];
  const channel: HostChannel & {
    probe: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  } = {
    probe: vi.fn(async () => options.trusted ?? true),
    request: vi.fn(
      async (sourceId: string, path: string, init: HostRequest) => {
        calls.push({ sourceId, path, init });
        if (path === "/api/sources")
          return reply({
            body: { sources: [], remotes: (options.remotes ?? remotes)() },
          });
        return reply(
          options.create?.() ?? {
            body: { link: { linkId: "lnk_new" }, url: SECRET_URL() },
          },
        );
      },
    ),
    dispose: vi.fn(),
  };
  return { channel, calls };
}

function mountWith(
  path: string,
  channel: HostChannel | null,
  options: MockOptions = {},
) {
  visit(path);
  const api = createMockApi(options);
  render(<ConsoleRoot api={api} endorser={null} hostChannel={channel} />);
  return api;
}

async function openNewLink() {
  fireEvent.click(await screen.findByRole("button", { name: "新建链接" }));
  return screen.findByRole("dialog", { name: "新建链接" });
}

const submit = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole("button", { name: "创建链接" }));

describe("主机详情 · 链接 · 新建链接", () => {
  it("主人：自己的主机的链接页签有「新建链接」", async () => {
    const { channel } = fakeChannel();
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    expect(
      await screen.findByRole("button", { name: "新建链接" }),
    ).toBeTruthy();
  });

  it("非主人不渲染：团队 owner 看别人登记的主机", async () => {
    const { channel } = fakeChannel();
    mountWith(`/t/rd/hosts/${MOCK_HOSTS[1]!.sourceId}?tab=links`, channel, {
      emailVerified: true,
    });
    expect(await screen.findByRole("tab", { name: "链接" })).toBeTruthy();
    await screen.findByText(/没有链接|For /);
    expect(screen.queryByRole("button", { name: "新建链接" })).toBeNull();
  });

  it("member 看别人的主机：没有页签，也没有新建链接", async () => {
    const { channel } = fakeChannel();
    mountWith(`/t/rd/hosts/${MOCK_HOSTS[2]!.sourceId}?tab=links`, channel, {
      emailVerified: true,
      roles: { rd: "member" },
    });
    expect((await h1()).textContent).toBe("dev-box");
    expect(screen.queryByRole("button", { name: "新建链接" })).toBeNull();
  });

  it("没有通道池（展示页）：不渲染", async () => {
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, null);
    expect(await screen.findByText("给小李看进度")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建链接" })).toBeNull();
  });

  it("浏览器不受信：提示先打开一次主机，「打开主机」新标签去 /h/；不登录、不发请求", async () => {
    const { channel } = fakeChannel({ trusted: false });
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const dialog = await openNewLink();
    submit(dialog);
    expect(
      await within(dialog).findByText("先在这个浏览器里打开一次这台主机"),
    ).toBeTruthy();
    const open = within(dialog).getByRole("link", { name: "打开主机" });
    expect(open.getAttribute("href")).toBe(`/h/${LAPTOP}`);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(channel.probe).toHaveBeenCalledWith(LAPTOP);
    expect(channel.request).not.toHaveBeenCalled();
  });

  it("成功：主机建整台的链接（这个控制台的 SaaS 行、缺省只读 7 天），结果只显示一次、可复制", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    const { channel, calls } = fakeChannel();
    const api = mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const list = vi.spyOn(api.client.links, "list");
    const dialog = await openNewLink();
    fireEvent.change(within(dialog).getByLabelText("备注"), {
      target: { value: "  给小王  " },
    });
    submit(dialog);
    const result = await screen.findByRole("dialog", { name: "链接已创建" });
    const input = within(result).getByLabelText("链接") as HTMLInputElement;
    expect(input.value).toBe(SECRET_URL());
    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ["GET", "/api/sources"],
      ["POST", "/api/sources/remotes/svc_console/links"],
    ]);
    expect(calls.every((call) => call.sourceId === LAPTOP)).toBe(true);
    expect(calls[1]!.init.body).toEqual({
      serviceId: "svc_console",
      workspaceId: "",
      target: "host",
      readOnly: true,
      role: "viewer",
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      maxUses: 1000,
      label: "给小王",
    });
    fireEvent.click(within(result).getByRole("button", { name: "复制链接" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(SECRET_URL()));
    // 列表随之重取；秘密不进地址与存储。
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(window.location.href).not.toContain("s3cr3t");
    expect(JSON.stringify({ ...localStorage })).not.toContain("s3cr3t");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("s3cr3t");
    // 关掉之后再开是空表单，整条链接不再出现。
    fireEvent.click(within(result).getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain("s3cr3t");
    const again = await openNewLink();
    expect(within(again).queryByLabelText("链接")).toBeNull();
    expect(document.body.innerHTML).not.toContain("s3cr3t");
  });

  it("次数上限按输入交给主机", async () => {
    const { channel, calls } = fakeChannel();
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const dialog = await openNewLink();
    fireEvent.change(within(dialog).getByLabelText("次数上限"), {
      target: { value: "3" },
    });
    submit(dialog);
    await screen.findByRole("dialog", { name: "链接已创建" });
    expect(calls[1]!.init.body).toMatchObject({ maxUses: 3, role: "viewer" });
  });

  it("次数上限不合法：创建按钮不可用", async () => {
    const { channel } = fakeChannel();
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const dialog = await openNewLink();
    fireEvent.change(within(dialog).getByLabelText("次数上限"), {
      target: { value: "0" },
    });
    expect(
      (
        within(dialog).getByRole("button", {
          name: "创建链接",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("forbidden（主机不认你作主人）：给补登录的命令", async () => {
    const { channel } = fakeChannel({
      create: () => ({ status: 403, body: { code: "forbidden" } }),
    });
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const dialog = await openNewLink();
    submit(dialog);
    expect(
      await within(dialog).findByText("这台主机把你当作成员，不是主人"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        `armadra-server cloud login --issuer ${window.location.origin}`,
      ),
    ).toBeTruthy();
  });

  it.each([
    [
      "主机没有这个控制台的 SaaS 行（只 --token 登记）",
      () => remotes().slice(0, 3),
      undefined,
    ],
    ["主机答 cloud_not_registered", undefined, "cloud_not_registered"],
    [
      "主机答 source_unauthorized（登录失效）",
      undefined,
      "source_unauthorized",
    ],
  ] as const)("%s：提示在主机上 cloud login", async (_name, rows, code) => {
    const { channel, calls } = fakeChannel({
      ...(rows === undefined ? {} : { remotes: rows }),
      ...(code === undefined
        ? {}
        : { create: () => ({ status: 401, body: { code } }) }),
    });
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const dialog = await openNewLink();
    submit(dialog);
    expect(
      await within(dialog).findByText("这台主机还没登录 Armadra 云"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        `armadra-server cloud login --issuer ${window.location.origin}`,
      ),
    ).toBeTruthy();
    if (rows !== undefined)
      expect(calls.map((call) => call.path)).toEqual(["/api/sources"]);
  });

  it("其余的码按控制台文案（团队设置不允许）；对话框留着", async () => {
    const { channel } = fakeChannel({
      create: () => ({ status: 403, body: { code: "team_policy_denied" } }),
    });
    mountWith(`/me/hosts/${LAPTOP}?tab=links`, channel);
    const dialog = await openNewLink();
    submit(dialog);
    expect(
      await within(dialog).findByText(
        describeFailure(new CloudConsoleError("team_policy_denied", 403)),
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "创建链接" }),
    ).toBeTruthy();
  });
});
