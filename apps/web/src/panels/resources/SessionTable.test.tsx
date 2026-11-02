import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SessionResources } from "@armadra/shared";

vi.mock("@/session", () => ({
  sessionGateway: { terminate: vi.fn(() => Promise.resolve()) },
}));
vi.mock("@/sessions/SessionRow", () => ({ centerNode: vi.fn() }));

import { SessionTable } from "./SessionTable";
import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import type { SessionRow } from "@/agent/sessions";

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

/** 读模型里的一行：标题照旧取 `cwd` 的末级目录，只给不关心命名的老用例用。 */
const rowFor = (
  entry: SessionResources,
  patch: Partial<SessionRow> = {},
): SessionRow =>
  ({
    nodeId: `node-${entry.sessionId}`,
    boardId: "board-a",
    sessionId: entry.sessionId,
    title: entry.cwd.split("/").pop() ?? "",
    cwd: entry.cwd,
    unread: false,
    updatedAt: "2026-11-02T00:00:00Z",
    alive: true,
    sinceMs: 0,
    ...patch,
  }) as SessionRow;

function Table(props: Parameters<typeof SessionTable>[0]) {
  return (
    <SessionTable
      sessionRows={props.sessions.map((entry) => rowFor(entry))}
      {...props}
    />
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  useCanvasStore.setState({ boards: [], document: null });
});
afterEach(() => cleanup());

describe("会话表", () => {
  it("退出的会话和进程找不到的会话都不出现在列表里", () => {
    render(
      <Table
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
      <Table
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
      <Table
        sessions={[session({ alive: false, unknownReason: "exited" })]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("空闲的行默认折起来，点开才列出", () => {
    render(
      <Table
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
      <Table
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
      <Table
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

describe("会话组的标题", () => {
  const boards = [
    { id: "board-a", name: "画板 A", nodeCount: 2, sortOrder: 0 },
    { id: "board-b", name: "登录改造", nodeCount: 2, sortOrder: 0 },
  ];

  it("标题是节点标题，不退到工作空间根目录名 default", () => {
    // 默认工作空间的根目录就叫 default，所有终端的 cwd 末级都是它。
    const first = session({
      sessionId: "s-1",
      cwd: "/data/workspaces/default",
    });
    const second = session({
      sessionId: "s-2",
      cwd: "/data/workspaces/default",
    });
    render(
      <SessionTable
        sessions={[first, second]}
        sessionRows={[
          rowFor(first, { title: "接口重构" }),
          rowFor(second, { title: "登录修复" }),
        ]}
        sort="name"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("接口重构")).toBeTruthy();
    expect(screen.getByText("登录修复")).toBeTruthy();
    expect(screen.queryByText("default")).toBeNull();
  });

  it("查不到节点时写中性占位，而不是目录名", () => {
    render(
      <SessionTable
        sessions={[
          session({ sessionId: "abcdef123", cwd: "/data/workspaces/default" }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("终端 abcdef")).toBeTruthy();
    expect(screen.queryByText("default")).toBeNull();
  });

  it("按节点 id 对上读模型，别的画板上的会话也有标题、Agent 与画板名", () => {
    useCanvasStore.setState({
      boards,
      document: { board: { id: "board-a" }, nodes: [] } as never,
    });
    const here = session({ sessionId: "s-1", nodeId: "n-1" });
    const there = session({ sessionId: "s-2", nodeId: "n-2" });
    render(
      <SessionTable
        sessions={[here, there]}
        sessionRows={[
          rowFor(here, { nodeId: "n-1", title: "接口重构", agentId: "claude" }),
          rowFor(there, {
            nodeId: "n-2",
            boardId: "board-b",
            title: "登录修复",
            agentId: "codex",
          }),
        ]}
        sort="name"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("登录修复")).toBeTruthy();
    // 当前画板上的会话不重复写画板名；别的画板上的写。
    expect(screen.getAllByText("登录改造")).toHaveLength(1);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("只有一块画板时不写画板名", () => {
    useCanvasStore.setState({
      boards: [boards[0]!],
      document: { board: { id: "board-a" }, nodes: [] } as never,
    });
    const only = session({ sessionId: "s-1" });
    render(
      <SessionTable
        sessions={[only]}
        sessionRows={[rowFor(only, { title: "接口重构", boardId: "board-b" })]}
        sort="name"
        onSorted={() => {}}
      />,
    );
    expect(screen.queryByText("登录改造")).toBeNull();
  });

  it("排序按钮暴露选中状态，并列的行按名字稳定排列", () => {
    const a = session({
      sessionId: "s-b",
      cpuPercent: null,
      memoryBytes: null,
    });
    const b = session({
      sessionId: "s-a",
      cpuPercent: null,
      memoryBytes: null,
    });
    render(
      <SessionTable
        sessions={[a, b]}
        sessionRows={[rowFor(a, { title: "乙" }), rowFor(b, { title: "甲" })]}
        sort="cpu"
        onSorted={() => {}}
        host="all"
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "按 CPU" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "按内存" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("进程树默认收起；展开后 Armadra 自己的进程有标记并排在同级最后", async () => {
    const withTree = session({
      sessionId: "s-1",
      pid: 100,
      childCount: 3,
      children: [
        {
          pid: 103,
          startTimeUnixMs: 1,
          name: "Armadra Helper",
          parentPid: 101,
          memoryBytes: 9000,
          cpuPercent: 0,
          origin: "armadra",
        },
        {
          pid: 102,
          startTimeUnixMs: 1,
          name: "node_repl",
          parentPid: 101,
          memoryBytes: 100,
          cpuPercent: 0,
        },
        {
          pid: 101,
          startTimeUnixMs: 1,
          name: "codex",
          parentPid: 100,
          memoryBytes: 5000,
          cpuPercent: 1,
        },
      ],
    });
    render(
      <SessionTable
        sessions={[withTree]}
        sessionRows={[rowFor(withTree, { title: "测试补全" })]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(screen.queryByText("codex")).toBeNull();
    screen.getByRole("button", { name: "展开进程树" }).click();
    await waitFor(() => expect(screen.getByText("codex")).toBeTruthy());
    const names = [...document.querySelectorAll("[data-depth]")].map((li) => [
      li.getAttribute("data-depth"),
      li.querySelector("span.truncate")?.textContent,
    ]);
    expect(names).toEqual([
      ["0", "codex"],
      ["1", "node_repl"],
      ["1", "Armadra Helper"],
    ]);
    expect(
      document.querySelectorAll("[data-slot=process-armadra]"),
    ).toHaveLength(1);
  });
});
