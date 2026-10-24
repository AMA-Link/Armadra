import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CloudConsoleError } from "../api/errors";
import type { MockHost } from "../mock/fixtures";

import { chooseOption, installDomPolyfills } from "../../app/test-harness";
import { MOCK_HOSTS, MOCK_PEOPLE } from "../mock/fixtures";
import { h1, installConsoleHarness, mount, viewport } from "../testkit";

installConsoleHarness();
installDomPolyfills();

const OPTIONS = { emailVerified: true } as const;
const BUILD = MOCK_HOSTS[0]!.sourceId;
const STUDIO = MOCK_HOSTS[1]!.sourceId;

/** 授予表；各台主机的授予都到齐（行内加载提示消失）才返回。 */
const table = async () => {
  const grid = await screen.findByRole("table", { name: "授予" });
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "授予" })).toBeNull(),
  );
  return grid;
};

/** 行里的名字（头像首字不算）。 */
const nameOf = (row: HTMLElement) =>
  row.querySelector("[translate]")?.textContent ?? "";

async function rowOf(name: string) {
  const grid = await table();
  const row = within(grid)
    .getAllByRole("row")
    .slice(1)
    .find((entry) => nameOf(entry) === name);
  if (!row) throw new Error(`没有「${name}」这一行`);
  return row;
}

const expand = async (name: string) => {
  const row = await rowOf(name);
  fireEvent.click(within(row).getByRole("button", { expanded: false }));
};

describe("团队 · 授予（按人）", () => {
  it("团队全员与每个有授予的人各一行：主机数 · 最高权限 · 最早到期", async () => {
    mount("/t/rd/grants", OPTIONS);
    expect((await h1()).textContent).toBe("授予");
    const grid = await table();
    await within(grid).findByText("赵六");
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows.map(nameOf)).toEqual(["团队全员", "李四", "王五", "赵六"]);
    const cell = (name: string, at: number) =>
      within(rows.find((row) => nameOf(row) === name)!).getAllByRole("cell")[
        at
      ]!.textContent;
    // 团队全员：build-01 只读、dev-box 可编辑 → 2 台，最高可编辑，永不到期。
    expect(cell("团队全员", 1)).toBe("2 台主机");
    expect(cell("团队全员", 2)).toBe("可编辑");
    expect(cell("团队全员", 3)).toBe("—");
    expect(cell("李四", 1)).toBe("1 台主机");
    expect(cell("李四", 2)).toBe("可执行");
    expect(cell("赵六", 2)).toBe("可编辑");
    // 有到期的行写出「N 天后到期」（赵六一周后到期）。
    expect(cell("赵六", 3)).toMatch(/天后到期/);
  });

  it("展开：逐台主机的授予、授予人，人带有效权限（合成降级标「已降低」）", async () => {
    mount("/t/rd/grants", OPTIONS);
    await expand("王五");
    const list = await screen.findByRole("list", { name: "王五" });
    const item = within(list).getAllByRole("listitem")[0]!;
    expect(item.textContent).toContain("build-01");
    expect(item.textContent).toContain("可接管");
    expect(item.textContent).toContain("1 个工作空间");
    await waitFor(() => expect(item.textContent).toContain("已降低"));
    expect(item.textContent).toContain("有效权限只读");
    expect(item.textContent).toContain("授予人 张三");
    expect(
      within(item).getByRole("link", { name: "build-01" }).getAttribute("href"),
    ).toMatch(/^\/t\/rd\/hosts\/0123/);
  });

  it("搜索对象；无匹配写出查询词并给「清除筛选」", async () => {
    mount("/t/rd/grants", OPTIONS);
    await rowOf("赵六");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索对象" }), {
      target: { value: "李" },
    });
    await waitFor(async () => {
      const grid = await table();
      expect(within(grid).queryByText("赵六")).toBeNull();
    });
    expect(await rowOf("李四")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索对象" }), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText("没有匹配「zzz」的结果")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await rowOf("赵六")).toBeTruthy();
  });

  it("窄屏同一份列定义画成 Item", async () => {
    viewport(true);
    mount("/t/rd/grants", OPTIONS);
    const list = await screen.findByRole("list", { name: "授予" });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThanOrEqual(
      4,
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("没有授予：空态给「添加访问」", async () => {
    mount("/t/rd/grants", { ...OPTIONS, noGrants: true });
    const empty = await screen.findByText("没有授予");
    expect(
      within(empty.closest("[data-state-kind=empty]") as HTMLElement).getByRole(
        "button",
        { name: "添加访问" },
      ),
    ).toBeTruthy();
  });
});

describe("授予页 · 角色可见性", () => {
  it("member 只见自己登记的主机上的授予（团队全员只剩 build-01 一台）", async () => {
    mount("/t/rd/grants", { ...OPTIONS, roles: { rd: "member" } });
    const grid = await table();
    await within(grid).findByText("李四");
    const team = (await rowOf("团队全员")).textContent;
    expect(team).toContain("1 台主机");
    expect(team).toContain("只读");
  });

  it("guest 与 billing 到不了这一页", async () => {
    for (const role of ["guest", "billing"] as const) {
      mount("/t/rd/grants", { ...OPTIONS, roles: { rd: role } });
      await h1();
      expect(screen.queryByRole("table", { name: "授予" })).toBeNull();
      expect(screen.queryByRole("button", { name: "添加访问" })).toBeNull();
    }
  });
});

describe("授予页 · 增改撤", () => {
  it("行内「撤销访问」：确认后这一台的授予消失，只有这一台的人整行消失", async () => {
    mount("/t/rd/grants", OPTIONS);
    await expand("李四");
    const list = await screen.findByRole("list", { name: "李四" });
    fireEvent.click(
      within(list).getByRole("button", { name: /^撤销 李四 · build-01/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("撤销 李四 对 build-01 的访问？"),
    ).toBeTruthy();
    const action = within(confirm).getByRole("button", { name: "撤销访问" });
    await waitFor(() => expect(action.getAttribute("aria-busy")).toBeNull());
    fireEvent.click(action);
    const grid = await screen.findByRole("table", { name: "授予" });
    await waitFor(() => expect(within(grid).queryByText("李四")).toBeNull());
  });

  it("行内「改权限」固定主机与对象；降角色先提示，确认后更新", async () => {
    mount("/t/rd/grants", OPTIONS);
    await expand("李四");
    const list = await screen.findByRole("list", { name: "李四" });
    fireEvent.click(
      within(list).getByRole("button", { name: "改权限 · build-01" }),
    );
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
    expect(within(dialog).queryByRole("combobox", { name: "主机" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: "只读" }));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "仍然更新" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await rowOf("李四")).textContent).toContain("只读");
  });

  it("添加访问：选主机与对象，授予后这个人出现在列表里", async () => {
    mount("/t/rd/grants", OPTIONS);
    await rowOf("赵六");
    fireEvent.click(screen.getByRole("button", { name: "添加访问" }));
    const dialog = await screen.findByRole("dialog", { name: "添加访问" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "主机" }));
    fireEvent.click(await screen.findByRole("option", { name: "mac-studio" }));
    fireEvent.click(within(dialog).getByRole("combobox", { name: "对象" }));
    fireEvent.click(await screen.findByRole("option", { name: /王五/ }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "可编辑" }));
    await chooseOption(
      within(dialog).getByRole("combobox", { name: "到期" }),
      "30 天",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "授予" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(async () => {
      expect((await rowOf("王五")).textContent).toContain("2 台主机");
    });
  });

  it("撤销即时反映：别处新增 / 撤销授予，收到 grantChanged 后列表自己更新", async () => {
    const api = mount("/t/rd/grants", OPTIONS);
    await rowOf("赵六");
    // 另一位管理员给王五在 mac-studio 加了授予、撤了赵六在 build-01 的授予。
    await api.client.grants.create({
      sourceId: STUDIO,
      subject: { kind: "member", accountId: MOCK_PEOPLE.member.accountId },
      role: "viewer",
    });
    const zhao = await api.client.grants.list({
      sourceId: BUILD,
      accountId: MOCK_PEOPLE.guest.accountId,
    });
    await api.client.grants.revoke({ grantId: zhao.grants[0]!.grantId });
    await act(async () => {
      api.emit({
        type: "grantChanged",
        sourceId: STUDIO,
        teamId: "team_mock_rd",
        atMs: Date.now(),
      });
      api.emit({
        type: "grantChanged",
        sourceId: BUILD,
        teamId: "team_mock_rd",
        atMs: Date.now(),
      });
    });
    await waitFor(async () => {
      const grid = await table();
      expect(within(grid).queryByText("赵六")).toBeNull();
      expect((await rowOf("王五")).textContent).toContain("2 台主机");
    });
  });
});

const bulk = (count: number): MockHost[] =>
  Array.from({ length: count }, (_, index) => ({
    ...MOCK_HOSTS[2]!,
    sourceId: (3000 + index).toString(16).padStart(32, "0"),
    name: `bulk-${String(index).padStart(3, "0")}`,
    owner: false,
    ownerName: "李四",
  }));

describe("授予页 · 主机很多、取数失败与撤销提示", () => {
  it("grants.list 同时在途不超过 6 个", async () => {
    const api = mount("/t/rd/grants", {
      ...OPTIONS,
      latencyMs: 15,
      extraHosts: bulk(40),
    });
    const real = api.client.grants.list;
    let active = 0;
    let peak = 0;
    let calls = 0;
    api.client.grants.list = (async (input: Parameters<typeof real>[0]) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await real(input);
      } finally {
        active -= 1;
      }
    }) as typeof real;
    await rowOf("赵六");
    expect(calls).toBeGreaterThan(40);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("单台主机的授予取不到：只标在那台上并可单台重试，其余照常列出", async () => {
    const api = mount("/t/rd/grants", { ...OPTIONS, latencyMs: 5 });
    const real = api.client.grants.list;
    let broken = true;
    api.client.grants.list = (async (input: Parameters<typeof real>[0]) => {
      if (broken && input.sourceId === STUDIO)
        throw new CloudConsoleError("team_role_insufficient", 403);
      return real(input);
    }) as typeof real;
    expect(await screen.findByText(/^mac-studio：/)).toBeTruthy();
    // 其余主机的授予照常。
    expect(await rowOf("赵六")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText(/^mac-studio：/)).toBeNull());
  });

  it("主机超过一页：提示列表不完整并给「加载更多」", async () => {
    mount("/t/rd/grants", { ...OPTIONS, extraHosts: bulk(210) });
    expect(await screen.findByText("只列出了前 200 台主机的授予")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(screen.queryByText("只列出了前 200 台主机的授予")).toBeNull(),
    );
  });

  it("撤销团队全员的授予：列出会被收窄的人", async () => {
    mount("/t/rd/grants", OPTIONS);
    await expand("团队全员");
    const list = await screen.findByRole("list", { name: "团队全员" });
    fireEvent.click(
      within(list).getAllByRole("button", {
        name: /^撤销 团队全员 · build-01/,
      })[0]!,
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      await within(confirm).findByText(
        "会降低 王五 的权限，他们已有的连接会断开",
      ),
    ).toBeTruthy();
  });

  it("撤销确认等授予与访问表都到了才可点：所有者不会被误列进收窄名单", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((go) => {
      release = go;
    });
    mount("/t/rd/grants", OPTIONS, null, (api) => {
      const real = api.client.sources.accessList;
      api.client.sources.accessList = (async (
        input: Parameters<typeof real>[0],
      ) => {
        await gate;
        return real(input);
      }) as typeof real;
    });
    await expand("团队全员");
    const list = await screen.findByRole("list", { name: "团队全员" });
    fireEvent.click(
      within(list).getAllByRole("button", {
        name: /^撤销 团队全员 · build-01/,
      })[0]!,
    );
    const confirm = await screen.findByRole("alertdialog");
    const action = within(confirm).getByRole("button", { name: "撤销访问" });
    expect(action.getAttribute("aria-busy")).toBe("true");
    expect(within(confirm).queryByText(/会降低/)).toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(action.getAttribute("aria-busy")).toBeNull());
    expect(
      await within(confirm).findByText(
        "会降低 王五 的权限，他们已有的连接会断开",
      ),
    ).toBeTruthy();
  });

  it("某台主机的授予还在加载：整页不回骨架，其余主机的行照常列出", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((go) => {
      release = go;
    });
    mount("/t/rd/grants", OPTIONS, null, (api) => {
      const real = api.client.grants.list;
      api.client.grants.list = (async (input: Parameters<typeof real>[0]) => {
        if (input.sourceId === STUDIO) await gate;
        return real(input);
      }) as typeof real;
    });
    const grid = await screen.findByRole("table", { name: "授予" });
    expect(await within(grid).findByText("赵六")).toBeTruthy();
    expect(screen.getByRole("status", { name: "授予" })).toBeTruthy();
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "授予" })).toBeNull(),
    );
  });

  it("撤销确认依赖的访问表取失败：显示原因并给重试，重试后恢复可点", async () => {
    let broken = true;
    mount("/t/rd/grants", OPTIONS, null, (api) => {
      const real = api.client.sources.accessList;
      api.client.sources.accessList = (async (
        input: Parameters<typeof real>[0],
      ) => {
        if (broken) throw new CloudConsoleError("team_role_insufficient", 403);
        return real(input);
      }) as typeof real;
    });
    await expand("团队全员");
    const list = await screen.findByRole("list", { name: "团队全员" });
    fireEvent.click(
      within(list).getAllByRole("button", {
        name: /^撤销 团队全员 · build-01/,
      })[0]!,
    );
    const confirm = await screen.findByRole("alertdialog");
    const retry = await within(confirm).findByRole("button", { name: "重试" });
    expect(
      within(confirm).queryByRole("button", { name: "撤销访问" }),
    ).toBeNull();
    broken = false;
    fireEvent.click(retry);
    expect(
      await within(confirm).findByRole("button", { name: "撤销访问" }),
    ).toBeTruthy();
  });
});
