import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PERSONAL } from "../mock/fixtures";
import { h1, mount, installConsoleHarness } from "../testkit";

installConsoleHarness();

const LAPTOP = MOCK_PERSONAL.linkHost;

describe("个人 · 概览", () => {
  it("三张卡：主机在线数、本月流量、计划；待处理行；主机前几行与「查看全部」", async () => {
    mount("/me");
    expect((await h1()).textContent).toBe("概览");
    expect(await screen.findByText("1 / 2 在线")).toBeTruthy();
    expect(screen.getByText("1.2 GB / 5 GB")).toBeTruthy();
    expect(screen.getByText("免费版")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "本月流量" });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(20);
    expect(await screen.findByText("待处理")).toBeTruthy();
    expect(screen.getByText("李四 的 iPad 待信任 · build-01")).toBeTruthy();
    expect(screen.getByText("李四 邀请了你")).toBeTruthy();
    expect(screen.getByRole("link", { name: "laptop" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "查看全部" }).getAttribute("href"),
    ).toBe("/me/hosts");
  });

  it("待处理里的设备信任去团队的设备信任页", async () => {
    mount("/me");
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(window.location.pathname).toBe("/t/rd/trust");
  });

  it("invitationChanged 与 deviceTrustRequested 让概览的待处理重拉", async () => {
    const api = mount("/me");
    await screen.findByText("李四 邀请了你");
    await screen.findByText(/待信任/);
    const invitations = vi.spyOn(api.client.invitations, "list");
    const trust = vi.spyOn(api.client.trust, "list");
    act(() =>
      api.emit({
        type: "invitationChanged",
        invitationId: "inv_rd",
        teamId: "team_mock_rd",
        state: "accepted",
        atMs: Date.now(),
      }),
    );
    await waitFor(() => expect(invitations).toHaveBeenCalledTimes(1));
    act(() =>
      api.emit({
        type: "deviceTrustRequested",
        requestId: "trust_ipad",
        sourceId: LAPTOP,
        atMs: Date.now(),
      }),
    );
    await waitFor(() => expect(trust).toHaveBeenCalledTimes(1));
  });

  it("主机多于一页（200）：总数写「200+」", async () => {
    mount("/me", {
      extraHosts: Array.from({ length: 210 }, (_, index) => ({
        sourceId: (5000 + index).toString(16).padStart(32, "0"),
        name: `bulk-${index}`,
        kind: "server" as const,
        online: index % 2 === 0,
        lastSeenAtMs: Date.UTC(2025, 9, 9),
        owner: true,
        ownerName: "张三",
        via: "owner" as const,
        relayOrigin: "https://relay.armadra.test",
        coreVersion: "0.9.3",
      })),
    });
    expect(await screen.findByText("100 / 200+ 在线")).toBeTruthy();
  });

  it("空：没有主机与待处理时，待处理整组不渲染，主机给空态", async () => {
    mount("/me", { hosts: [], without: ["pending"] });
    expect(await screen.findByText("还没有主机")).toBeTruthy();
    expect(screen.getByText("0 / 0 在线")).toBeTruthy();
    expect(screen.queryByText("待处理")).toBeNull();
  });

  it("加载：卡片先画骨架", async () => {
    mount("/me", { latencyMs: 80 });
    await h1();
    expect(document.querySelector("[data-slot='skeleton']")).toBeTruthy();
    await screen.findByText("1 / 2 在线");
  });

  it("错：一张卡取数失败只影响那一张，带重试", async () => {
    mount("/me", { fail: { "billing.usage": "rate_limited" } });
    expect(await screen.findByText("1 / 2 在线")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByText("免费版")).toBeTruthy();
  });
});
