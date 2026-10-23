import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OPS_QUERY_KEY } from "./TenantsPage";
import { ConsoleRoot } from "../ConsoleRoot";
import { createMockApi, type MockOptions } from "../mock/create-mock-client";

const visit = (path: string) => window.history.replaceState(null, "", path);

beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  visit("/");
});

const mount = (path: string, options: MockOptions = {}, q?: string) => {
  visit(path);
  if (q !== undefined) sessionStorage.setItem(OPS_QUERY_KEY, q);
  const api = createMockApi({
    operatorAccount: true,
    operatorSession: true,
    ...options,
  });
  render(<ConsoleRoot api={api} />);
  return api;
};
const h1 = () => screen.findByRole("heading", { level: 1 });

/** 打开确认框，按给定的理由与名字填，点确认按钮。 */
async function confirmWith(
  action: string,
  fields: { reason?: string; name?: string },
) {
  const dialog = await screen.findByRole("alertdialog");
  if (fields.reason !== undefined)
    fireEvent.change(within(dialog).getByLabelText("理由"), {
      target: { value: fields.reason },
    });
  if (fields.name !== undefined)
    fireEvent.change(within(dialog).getByLabelText(/^输入 .* 确认$/), {
      target: { value: fields.name },
    });
  fireEvent.click(within(dialog).getByRole("button", { name: action }));
  return dialog;
}

describe("运营后台门控", () => {
  it("没有运营会话访问 /ops、/ops/nodes、/ops/status、/ops/tenants/:id 都是找不到", async () => {
    for (const path of [
      "/ops",
      "/ops/nodes",
      "/ops/status",
      "/ops/tenants/acct_mock_lisi?kind=account",
    ]) {
      mount(path, { operatorAccount: false, operatorSession: false });
      expect((await h1()).textContent).toBe("找不到这个页面");
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(screen.queryByText("运营")).toBeNull();
      cleanup();
    }
  });

  it("运营会话里侧栏带「运营」标识", async () => {
    mount("/ops/nodes");
    await h1();
    expect(screen.getByText("运营")).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回控制台" })).toBeTruthy();
  });

  it("operator_mfa_required 有自己的文案", async () => {
    visit("/login?scope=operator&next=%2Fops");
    const api = createMockApi({
      signedIn: false,
      fail: { "auth.login": "operator_mfa_required" },
    });
    render(<ConsoleRoot api={api} />);
    fireEvent.change(await screen.findByLabelText("邮箱"), {
      target: { value: "op@example.com" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("运营账号要先开启两步验证")).toBeTruthy();
  });
});

describe("租户", () => {
  it("没查询不画表；搜索后账号与团队混排；无结果显示「没有匹配」", async () => {
    mount("/ops");
    await h1();
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();
    mount("/ops", {}, "li");
    expect(await screen.findByText("李四")).toBeTruthy();
    cleanup();
    mount("/ops", {}, "zzz");
    expect(await screen.findByText("没有匹配「zzz」的租户")).toBeTruthy();
  });

  it("停用团队：理由必填、名称要对；成功后详情变「已停用」，可恢复", async () => {
    const api = mount("/ops", {}, "研发");
    const status = vi.spyOn(api.ops.admin, "teamStatus");
    fireEvent.click(await screen.findByRole("link", { name: "研发组" }));
    const detail = await screen.findByRole("dialog");
    await within(detail).findByText("正常");
    fireEvent.click(within(detail).getByRole("button", { name: "停用" }));

    // 没理由：不调用，理由框标红。
    let dialog = await confirmWith("停用", { name: "研发组" });
    expect(status).not.toHaveBeenCalled();
    expect(within(dialog).getByText("填写理由")).toBeTruthy();
    // 有理由、名字不对：不调用。
    await confirmWith("停用", { reason: "滥用", name: "rd" });
    expect(status).not.toHaveBeenCalled();
    expect(within(dialog).getByText("与 研发组 不一致")).toBeTruthy();

    await confirmWith("停用", { reason: "滥用", name: "研发组" });
    await waitFor(() =>
      expect(status).toHaveBeenCalledWith({
        teamId: "team_mock_rd",
        status: "suspended",
        reason: "滥用",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(
      await within(detail).findByRole("button", { name: "恢复" }),
    );
    dialog = await confirmWith("恢复", { reason: "误判", name: "研发组" });
    await waitFor(() =>
      expect(status).toHaveBeenLastCalledWith({
        teamId: "team_mock_rd",
        status: "active",
        reason: "误判",
      }),
    );
  });

  it("停用自己被拒：提示没有权限，确认框留着", async () => {
    mount("/ops", {}, "张三");
    fireEvent.click(await screen.findByRole("link", { name: "张三" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(
      await within(detail).findByRole("button", { name: "停用" }),
    );
    await confirmWith("停用", { reason: "测试", name: "张三" });
    expect(await screen.findByText("没有权限执行这个操作")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("节点", () => {
  it("排空要理由与节点名；已在排空和离线的节点没有排空按钮", async () => {
    const api = mount("/ops/nodes");
    const drain = vi.spyOn(api.ops.admin, "relayNodeDrain");
    expect(await screen.findByText("relay-hk-1")).toBeTruthy();
    expect(screen.getByText("排空中")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^排空 / })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "排空 relay-hk-1" }));
    await confirmWith("排空", { name: "relay-hk-1" });
    expect(drain).not.toHaveBeenCalled();
    await confirmWith("排空", { reason: "升级", name: "relay-hk-1" });
    await waitFor(() =>
      expect(drain).toHaveBeenCalledWith({
        node: "relay-hk-1",
        drain: true,
        reason: "升级",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "排空 relay-hk-1" }),
      ).toBeNull(),
    );
  });
});

describe("事故开关", () => {
  it("三项开关，关掉要理由与开关名；第三项带 rejectNewConnections", async () => {
    const api = mount("/ops/status");
    const set = vi.spyOn(api.ops.admin, "incidentSet");
    const issue = await screen.findByRole("switch", { name: "签发访问" });
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(issue.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(issue);
    expect(await screen.findByText("暂停签发访问？")).toBeTruthy();
    await confirmWith("暂停签发", { reason: "事故", name: "签发" });
    expect(set).not.toHaveBeenCalled();
    await confirmWith("暂停签发", { reason: "事故", name: "签发访问" });
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        pauseAssertions: true,
        reason: "事故",
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "签发访问" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    fireEvent.click(screen.getByRole("switch", { name: "接受新连接" }));
    await confirmWith("拒绝新连接", { reason: "攻击", name: "接受新连接" });
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith({
        rejectNewConnections: true,
        reason: "攻击",
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "接受新连接" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });
});

describe("运营会话恢复与细节", () => {
  it("有运营范围但无运营会话：续得上就留在页内", async () => {
    mount("/ops/nodes", { operatorSession: false, operatorRefreshable: true });
    expect(await screen.findByText("relay-hk-1")).toBeTruthy();
    expect(window.location.pathname).toBe("/ops/nodes");
  });

  it("有运营范围但续不上：跳运营登录并带回当前路径", async () => {
    mount("/ops/status", { operatorSession: false });
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        "/login?scope=operator&next=%2Fops%2Fstatus",
      ),
    );
  });

  it("没有运营范围：仍是找不到，不尝试续也不跳登录", async () => {
    mount("/ops", { operatorAccount: false, operatorSession: false });
    expect((await h1()).textContent).toBe("找不到这个页面");
    expect(window.location.pathname).toBe("/ops");
  });

  it("搜索词不进地址栏，详情链接也不带它，输入框限 128 字", async () => {
    mount("/ops");
    const box = (await screen.findByRole("searchbox")) as HTMLInputElement;
    expect(box.maxLength).toBe(128);
    fireEvent.change(box, { target: { value: "研发" } });
    fireEvent.submit(box.closest("form")!);
    const link = await screen.findByRole("link", { name: "研发组" });
    expect(window.location.search).toBe("");
    expect(link.getAttribute("href")).not.toContain("q=");
    expect(sessionStorage.getItem(OPS_QUERY_KEY)).toBe("研发");
  });

  it("审计动作码走 i18n，认不出的原样显示", async () => {
    mount("/ops", {}, "研发");
    fireEvent.click(await screen.findByRole("link", { name: "研发组" }));
    const detail = await screen.findByRole("dialog");
    await within(detail).findByText("正常");
    fireEvent.click(within(detail).getByRole("button", { name: "停用" }));
    await confirmWith("停用", { reason: "滥用", name: "研发组" });
    expect(await within(detail).findByText("停用团队")).toBeTruthy();
  });

  it("事故开关：答复值与期望不符不弹成功；答复没有第三项就隐藏它", async () => {
    const api = mount("/ops/status");
    const real = api.ops.admin.incident;
    vi.spyOn(api.ops.admin, "incidentSet").mockResolvedValue({
      pauseAssertions: false,
      pauseRegistrations: false,
      rejectNewConnections: false,
      updatedAtMs: 1,
    } as never);
    fireEvent.click(await screen.findByRole("switch", { name: "签发访问" }));
    await confirmWith("暂停签发", { reason: "事故", name: "签发访问" });
    expect(
      await screen.findByText("服务端没有按要求更新，请刷新后重试"),
    ).toBeTruthy();
    cleanup();

    const api2 = mount("/ops/status");
    vi.spyOn(api2.ops.admin, "incident").mockImplementation(async (input) => {
      const { rejectNewConnections: _drop, ...rest } = (await real(
        input,
      )) as Record<string, unknown>;
      return rest as never;
    });
    await screen.findByRole("switch", { name: "签发访问" });
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });
});
