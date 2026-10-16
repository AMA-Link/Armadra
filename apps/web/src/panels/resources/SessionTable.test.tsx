import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SessionResources } from "@armadra/shared";

vi.mock("@/session", () => ({
  sessionGateway: { terminate: vi.fn(() => Promise.resolve()) },
}));
vi.mock("@/sessions/SessionRow", () => ({ centerNode: vi.fn() }));

import { SessionTable } from "./SessionTable";
import { usePreferencesStore } from "@/app/preferences-store";

/**
 * 会话表的一条验收：**进程不在了就不占一行**。
 *
 * 以前退出的会话会留在列表里，CPU / 内存全是短横线，副标题写「进程已经不
 * 在了」——用户读到的是一堆再也不会更新的死行。跑丢但进程还在的会话由
 * 「孤立会话」区块单独列，这里不代劳。
 */

const session = (patch: Partial<SessionResources> = {}): SessionResources => ({
  sessionId: "s-1",
  sessionKey: "s-1",
  workspaceId: "w-1",
  nodeId: null,
  generation: 1,
  backend: "direct",
  location: "local",
  executionHostId: "local",
  cwd: "/tmp/alpha",
  pid: 100,
  alive: true,
  cpuPercent: 4,
  memoryBytes: 1024,
  memoryEstimated: true,
  childCount: 0,
  state: "runnable",
  startTimeUnixMs: 1_788_556_300_000,
  children: [],
  unknownReason: null,
  ...patch,
});

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => cleanup());

describe("会话表", () => {
  it("退出的会话和进程找不到的会话都不出现在列表里", () => {
    render(
      <SessionTable
        sessions={[
          session({ sessionId: "live", cwd: "/tmp/live" }),
          session({
            sessionId: "ended",
            cwd: "/tmp/ended",
            alive: false,
            pid: null,
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "exited",
          }),
          session({
            sessionId: "gone",
            cwd: "/tmp/gone",
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "not-found",
          }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );

    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.queryByText("ended")).toBeNull();
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("说明只在悬停提示里，行内只有名字与数字", () => {
    render(
      <SessionTable
        sessions={[
          session({
            sessionId: "long",
            cwd: "/tmp/MacBookPro.local-with-a-long-name",
            cpuPercent: 8,
            childCount: 5,
            state: "sleeping",
            pid: 71113,
          }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    const row = screen.getByTitle(/^子进程 5 · sleeping · pid.71113$/);
    // 「pid」与号码之间是不折行空格；行内不再有那行小字。
    expect(row.getAttribute("title")).toContain("pid\u00a071113");
    expect(row.textContent).not.toContain("sleeping");
    expect(row.textContent).not.toContain("pid");
    const name = screen.getByText("MacBookPro.local-with-a-long-name");
    expect(name.closest("[title]")?.getAttribute("title")).toBe(
      "MacBookPro.local-with-a-long-name",
    );
  });

  it("一个会话都不剩时什么都不画，而不是一列死行", () => {
    const { container } = render(
      <SessionTable
        sessions={[session({ alive: false, unknownReason: "exited" })]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("空闲的行默认折起来，点开才列出", () => {
    render(
      <SessionTable
        sessions={[
          session({ sessionId: "busy", cwd: "/tmp/busy", cpuPercent: 40 }),
          session({ sessionId: "idle", cwd: "/tmp/idle", cpuPercent: 0 }),
          session({
            sessionId: "nopid",
            cwd: "/tmp/nopid",
            pid: null,
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "no-pid",
          }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("busy")).toBeTruthy();
    expect(screen.queryByText("idle")).toBeNull();
    expect(screen.queryByText("nopid")).toBeNull();
    screen.getByRole("button", { name: "空闲 2" }).click();
    return waitFor(() => {
      expect(screen.getByText("idle")).toBeTruthy();
      expect(screen.getByText("nopid")).toBeTruthy();
    });
  });

  it("没有会话也照样给出执行主机筛选：它同时管上面的主机总览", () => {
    // 远端工作空间刚建好、还没开终端时，抽屉里有本机与远端两张主机卡，却
    // 没有筛选——筛选长在会话表里，而会话表一行都没有就整段不画（远端探针
    // 实测）。
    const onHost = vi.fn();
    render(
      <SessionTable
        sessions={[]}
        sort="cpu"
        onSorted={() => {}}
        host="all"
        onHost={onHost}
        extraHosts={["local", "fake-remote"]}
        hostName={(id) => (id === "fake-remote" ? "假远端" : id)}
      />,
    );
    screen.getByRole("button", { name: "假远端" }).click();
    expect(onHost).toHaveBeenCalledWith("fake-remote");
    expect(screen.getByRole("button", { name: "全部主机" })).toBeTruthy();
  });

  it("远端会话测不到指标，但仍然留在列表里", () => {
    render(
      <SessionTable
        sessions={[
          session({
            sessionId: "ssh",
            cwd: "/tmp/ssh",
            location: "remote",
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "remote",
          }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("ssh")).toBeTruthy();
    expect(screen.getByTitle("在远程主机上运行，本机测不到指标")).toBeTruthy();
  });
});
