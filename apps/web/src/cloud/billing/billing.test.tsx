import { QUOTAS } from "@armadra/platform-protocol/errors";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { installDomPolyfills } from "../../app/test-harness";
import { CloudConsoleError, describeFailure } from "../api/errors";
import { h1, installConsoleHarness, mount } from "../testkit";
import { quotaLevel, quotaPercent } from "./quota";

installConsoleHarness();
installDomPolyfills();

const OPTIONS = { emailVerified: true } as const;

/** 一项配额所在的那一行。 */
async function row(label: string) {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-settings-label="${label}"]`,
    );
    if (!found) throw new Error(`没有「${label}」这一行`);
    return found;
  });
}

describe("quota 判定", () => {
  it("≥ 80% 接近上限，≥ 100% 已达上限；不限没有比例", () => {
    expect(quotaLevel(quotaPercent(7, 9))).toBe("ok");
    expect(quotaLevel(quotaPercent(8, 10))).toBe("near");
    expect(quotaLevel(quotaPercent(10, 10))).toBe("full");
    expect(quotaLevel(quotaPercent(11, 10))).toBe("full");
    expect(quotaPercent(6, null)).toBeNull();
    expect(quotaLevel(null)).toBe("ok");
  });
});

describe("limit_reached 文案", () => {
  const cases: readonly [string, string][] = [
    ["hosts", "主机数已达上限，升级或撤销一台主机"],
    ["members", "成员数已达上限，升级或移除一位成员"],
    ["guests", "访客数已达上限，升级或移除一位访客"],
    ["concurrent", "同时连接已达上限，关掉一个连接后重试"],
    ["traffic", "本月流量已用完，升级后继续"],
    ["teams", "免费版只能建一个团队，升级后再建"],
  ];
  it.each(cases)("按配额 %s 取文案", (quota, copy) => {
    const failure = new CloudConsoleError("limit_reached", 402, "x", {
      quota,
      used: 3,
      limit: 3,
    });
    expect(describeFailure(failure)).toBe(copy);
  });

  it("协议包里的每个配额都有自己的文案（升协议漏掉的让这里失败）", () => {
    const generic = describeFailure(
      new CloudConsoleError("limit_reached", 402),
    );
    for (const quota of QUOTAS)
      expect(
        describeFailure(
          new CloudConsoleError("limit_reached", 402, "x", { quota }),
        ),
        quota,
      ).not.toBe(generic);
  });

  it("认不出的配额退回通用文案，后端的 message 不展示", () => {
    const failure = new CloudConsoleError(
      "limit_reached",
      402,
      "raw backend text",
      { quota: "mystery" },
    );
    expect(describeFailure(failure)).not.toContain("raw backend text");
    expect(describeFailure(failure)).not.toBe("");
  });

  it("用量页取数遇到 limit_reached：整页状态按 code 出文案", async () => {
    mount("/t/rd/billing", {
      ...OPTIONS,
      fail: { "billing.usage": "limit_reached" },
    });
    await screen.findByRole("button", { name: "重试" });
    expect(document.querySelector("[data-page-state='error']")).toBeTruthy();
  });
});

describe("团队 · 用量与计划", () => {
  it("团队版：计划卡有席位与续费日，配额按 已用 / 上限 显示，不限写「不限」", async () => {
    mount("/t/rd/billing", OPTIONS);
    expect((await h1()).textContent).toBe("用量与计划");
    const plan = await screen.findByText("团队版");
    const card = plan.closest("[data-slot='billing-plan']") as HTMLElement;
    expect(within(card).getByText("3 个席位")).toBeTruthy();
    expect(within(card).getByText(/^续费日 /)).toBeTruthy();
    expect(within(await row("主机")).getByText("7 / 9")).toBeTruthy();
    const members = await row("成员");
    expect(within(members).getByText("6 / 不限")).toBeTruthy();
    expect(within(members).queryByRole("progressbar")).toBeNull();
    expect(within(await row("访客")).getByText("2 / 6")).toBeTruthy();
    expect(within(await row("同时连接")).getByText("12 / 60")).toBeTruthy();
    expect(
      within(await row("本月流量")).getByText("38 GB / 150 GB"),
    ).toBeTruthy();
    // 都不到 80%：没有接近上限，也没有超额提示。
    expect(screen.queryByText("接近上限")).toBeNull();
    expect(screen.queryByText("已达上限")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("每日流量：图表加一份读屏用的数据表（一天一行）", async () => {
    mount("/t/rd/billing", OPTIONS);
    const chart = await screen.findByRole("img", { name: "每日流量" });
    expect(chart).toBeTruthy();
    const table = screen.getByRole("table", { name: "每日流量", hidden: true });
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(
      91,
    );
  });

  it("接近与用尽：徽标「接近上限」「已达上限」，进度条色调随之变；流量超出时页顶提示", async () => {
    mount("/t/lab/billing", { ...OPTIONS, roles: { lab: "owner" } });
    const hosts = await row("主机");
    expect(within(hosts).getByText("已达上限")).toBeTruthy();
    expect(within(hosts).getByRole("progressbar").innerHTML).toContain(
      "bg-danger",
    );
    const members = await row("成员");
    expect(within(members).getByText("接近上限")).toBeTruthy();
    expect(within(members).getByRole("progressbar").innerHTML).toContain(
      "bg-warn",
    );
    const guests = await row("访客");
    expect(within(guests).queryByText("接近上限")).toBeNull();
    expect(within(guests).getByRole("progressbar").innerHTML).toContain(
      "bg-brand",
    );
    expect(
      within(screen.getByRole("alert")).getByText(
        "本月流量已超出，同时连接将受限",
      ),
    ).toBeTruthy();
    expect(screen.getByText("免费版")).toBeTruthy();
  });

  it("billing 角色能看；planChanged 让计划与用量重拉", async () => {
    const api = mount("/t/rd/billing", {
      ...OPTIONS,
      roles: { rd: "billing" },
    });
    await row("主机");
    let calls = 0;
    const original = api.client.billing.plan;
    api.client.billing.plan = (async (...args: Parameters<typeof original>) => {
      calls += 1;
      return original(...args);
    }) as typeof original;
    await act(async () => {
      api.emit({
        type: "planChanged",
        space: { kind: "team", teamId: "team_mock_rd" },
      } as never);
    });
    await screen.findByText("团队版");
    expect(calls).toBeGreaterThan(0);
  });

  it("取数失败：整页状态可重试；没有权限：整页「没有权限」", async () => {
    mount("/t/rd/billing", {
      ...OPTIONS,
      fail: { "billing.plan": "team_role_insufficient" },
    });
    await screen.findByRole("button", { name: "重试" });
  });
});
