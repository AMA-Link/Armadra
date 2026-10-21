import { scoped } from "../sources/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentApprovalRecord,
  AgentStatus,
  SessionSummary,
} from "@armadra/shared";

import { displayOfStatus, headerOf } from "./display";
import {
  isResolvedApproval,
  useAgentStatusStore,
  type MirroredStatus,
} from "./status-store";

/** 节点头要画的东西（不含推导它的 `display`）。 */
function agentHeaderState(status: MirroredStatus | undefined) {
  const { display: _display, ...rest } = headerOf(
    displayOfStatus(status),
    status?.unread ?? false,
  );
  return rest;
}

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";

/** `agent.approval` 带的审批行（core 的 `AgentApproval`）；`patch` 写答复。 */
function approvalRecord(
  id: string,
  patch: Partial<AgentApprovalRecord> = {},
): AgentApprovalRecord {
  return {
    id,
    nodeId: NODE,
    workspaceId: WORKSPACE,
    request: null,
    createdAt: "2026-10-06T00:00:00Z",
    ...patch,
  };
}
const BASE = Date.parse("2026-09-04T10:00:00.000Z");

function status(
  partial: Partial<AgentStatus> & { updatedAt: string },
): AgentStatus {
  return {
    nodeId: NODE,
    workspaceId: WORKSPACE,
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    ...partial,
  };
}

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

const store = () => useAgentStatusStore.getState();

/** 已读回执是 fire-and-forget 的 POST；测试里换成一个可断言的假 fetch。 */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAgentStatusStore.getState().reset();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("agent status mirror", () => {
  /**
   * S10：`DONE_HOLDOFF` 只在 core 算（`hook/reduce.ts`）。页面收到什么就是什么：
   * core 已经丢掉的迟到 `working` 不会到这里，到了的就是定论，不再有第二份计时。
   */
  it("takes a `working` after `done` as the runtime's verdict", () => {
    store().upsert(status({ state: "done", updatedAt: at(0) }), {
      now: BASE,
      selected: true,
      focused: true,
    });
    store().upsert(status({ state: "working", updatedAt: at(500) }), {
      now: BASE + 500,
    });
    expect(store().statuses[scoped(NODE)]!.state).toBe("working");
  });

  it("carries the runtime's unread badge when the node is not being watched", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: true,
      remote: false,
    });
    expect(store().statuses[scoped(NODE)]!.unread).toBe(true);

    store().markRead(NODE, { remote: false });
    expect(store().statuses[scoped(NODE)]!.unread).toBe(false);
  });

  it("counts a turn that ends under the user's eyes as read, and says so", async () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: true,
      focused: true,
    });
    expect(store().statuses[scoped(NODE)]!.unread).toBe(false);
    // 只有客户端知道用户在看，所以回执必须由客户端补，否则刷新后徽标回来。
    // 回执经契约客户端发（契约 §39.2 `agents.markRead`），多几拍微任务。
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toContain("/api/rpc/agents/markRead");
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain(NODE);
  });

  it("keeps the badge when the window is blurred even if the node is selected", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: true,
      focused: false,
      remote: false,
    });
    expect(store().statuses[scoped(NODE)]!.unread).toBe(true);
  });

  /**
   * §5.4/§5.7：未读只由已读回执清除。新回合不算「看过」——§5.7 的投递就是
   * 靠开新回合，用户可能压根没看上一回合的结果；而且 `GET /sessions` 直接
   * 读 SQLite 的 `unread`，本地擅自清掉只会让刷新一次徽标又冒出来。
   */
  it("does not clear the badge just because a new turn started", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: false,
      remote: false,
    });
    store().upsert(
      status({
        state: "working",
        unread: true,
        updatedAt: at(4_000),
      }),
      { now: BASE + 4_000, remote: false },
    );
    expect(store().statuses[scoped(NODE)]!.unread).toBe(true);
    expect(store().statuses[scoped(NODE)]!.state).toBe("working");
  });

  it("ignores frames older than the one already stored", () => {
    store().upsert(status({ state: "working", updatedAt: at(1_000) }), {
      now: BASE + 1_000,
    });
    store().upsert(status({ state: "blocked", updatedAt: at(500) }), {
      now: BASE + 1_000,
    });
    expect(store().statuses[scoped(NODE)]!.state).toBe("working");
  });

  it("attaches a pendingId from an approval event", () => {
    store().upsert(status({ state: "blocked", updatedAt: at(0) }), {
      now: BASE,
    });
    store().handleEvent({
      type: "agent.approval",
      nodeId: NODE,
      pendingId: "pending-1",
      request: approvalRecord("pending-1"),
    });
    expect(store().statuses[scoped(NODE)]!.pendingId).toBe("pending-1");
  });

  it("drops the mirror when the terminal exits", () => {
    store().upsert(status({ state: "working", updatedAt: at(0) }), {
      now: BASE,
    });
    store().handleEvent({
      type: "terminal.exit",
      sessionId: "s1",
      nodeId: NODE,
      exitCode: 0,
    });
    expect(scoped(NODE) in store().statuses).toBe(false);
  });

  it("hydrates from the sessions payload without clobbering fresher state", () => {
    const session: SessionSummary = {
      nodeId: NODE,
      boardId: "board",
      sessionId: "s1",
      kind: "terminal",
      title: "claude",
      cwd: "/repo",
      agentId: "claude",
      state: "done",
      unread: true,
      updatedAt: at(0),
      alive: true,
    };
    store().hydrate([session], WORKSPACE);
    expect(store().statuses[scoped(NODE)]!.state).toBe("done");
    expect(store().statuses[scoped(NODE)]!.unread).toBe(true);
    expect(store().statuses[scoped(NODE)]!.restored).toBe(true);

    store().upsert(status({ state: "working", updatedAt: at(10_000) }), {
      now: BASE + 10_000,
    });
    store().hydrate([session], WORKSPACE);
    expect(store().statuses[scoped(NODE)]!.state).toBe("working");
  });

  // 刷新后来源徽标要还在：`agent.status` 帧只描述下一个回合，重建镜像的
  // 是这份会话列表（协作通道 §3.2）。
  it("restores the state source a reload would otherwise drop", () => {
    store().hydrate(
      [
        {
          nodeId: NODE,
          boardId: "board",
          sessionId: "s1",
          kind: "terminal",
          title: "pi",
          cwd: "/repo",
          agentId: "pi",
          state: "done",
          stateSource: "extension",
          unread: false,
          updatedAt: at(0),
          alive: true,
        },
      ],
      WORKSPACE,
    );
    expect(store().statuses[scoped(NODE)]!.stateSource).toBe("extension");
  });

  // 没有来源的会话（自定义 CLI、还没有人上报过）不能被编造成一个来源。
  it("leaves the state source absent when the session reports none", () => {
    store().hydrate(
      [
        {
          nodeId: NODE,
          boardId: "board",
          sessionId: "s1",
          kind: "terminal",
          title: "claude",
          cwd: "/repo",
          agentId: "claude",
          state: "working",
          unread: false,
          updatedAt: at(0),
          alive: true,
        },
      ],
      WORKSPACE,
    );
    expect(store().statuses[scoped(NODE)]!.stateSource).toBeUndefined();
  });

  it("skips sessions without an agent", () => {
    store().hydrate(
      [
        {
          nodeId: NODE,
          boardId: "board",
          sessionId: "s1",
          kind: "terminal",
          title: "zsh",
          cwd: "/repo",
          unread: false,
          updatedAt: at(0),
          alive: true,
        },
      ],
      WORKSPACE,
    );
    expect(scoped(NODE) in store().statuses).toBe(false);
  });
  it("posts a read receipt when the unread badge is cleared", async () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: false,
      remote: false,
    });
    store().markRead(NODE);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/rpc/agents/markRead");
    expect(String(init.body)).toContain(NODE);
    expect(init.method).toBe("POST");

    // 已经读过了就不再发第二次回执。
    store().markRead(NODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the receipt when asked to stay local", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: false,
      remote: false,
    });
    store().markRead(NODE, { remote: false });
    expect(store().statuses[scoped(NODE)]!.unread).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the pendingId when the approval comes back resolved", () => {
    store().upsert(
      status({ state: "blocked", pendingId: "p1", updatedAt: at(0) }),
      { now: BASE },
    );
    store().handleEvent({
      type: "agent.approval",
      nodeId: NODE,
      pendingId: "p1",
      request: approvalRecord("p1", { answer: "allow", answeredAt: at(1) }),
    });
    expect(store().statuses[scoped(NODE)]!.pendingId).toBeUndefined();
    // 状态本身不动：下一条 `agent.status` 才有权改它。
    expect(store().statuses[scoped(NODE)]!.state).toBe("blocked");
  });

  it("recognises both resolved shapes", () => {
    expect(isResolvedApproval({ resolved: true })).toBe(true);
    expect(isResolvedApproval({ answer: "deny" })).toBe(true);
    expect(isResolvedApproval({ answeredAt: at(0) })).toBe(true);
    expect(isResolvedApproval({ answer: null })).toBe(false);
    expect(isResolvedApproval(undefined)).toBe(false);
  });

  /** S9：审批挂起只有 core 一份；过期由 core 清掉 `pendingId` 并发状态帧，页面没有计时器。 */
  it("follows the runtime when it drops an expired pending approval", () => {
    store().upsert(status({ state: "blocked", updatedAt: at(0) }), {
      now: BASE,
    });
    store().handleEvent(
      {
        type: "agent.approval",
        nodeId: NODE,
        pendingId: "p1",
        request: approvalRecord("p1"),
      },
      { now: BASE },
    );
    expect(store().statuses[scoped(NODE)]!.pendingId).toBe("p1");
    expect("sweepApprovals" in store()).toBe(false);

    store().upsert(status({ state: "blocked", updatedAt: at(300_000) }), {
      now: BASE + 300_000,
    });
    expect(store().statuses[scoped(NODE)]!.pendingId).toBeUndefined();
    expect(store().statuses[scoped(NODE)]!.state).toBe("blocked");
  });

  it("maps states to the pill and the glow", () => {
    expect(agentHeaderState(undefined)).toEqual({});
    expect(
      agentHeaderState(status({ state: "working", updatedAt: at(0) })),
    ).toEqual({
      pill: { tone: "working", labelKey: "status.working" },
      glow: "working",
    });
    expect(
      agentHeaderState(status({ state: "waiting", updatedAt: at(0) })),
    ).toEqual({
      pill: { tone: "attention", labelKey: "status.awaitingInput" },
      glow: "attention",
    });
    expect(
      agentHeaderState(
        status({ state: "done", unread: true, updatedAt: at(0) }),
      ),
    ).toEqual({
      pill: { tone: "unread", labelKey: "status.done" },
      glow: "unread",
    });
    // 读过的 done 不出胶囊，空闲节点头部保持干净（§14）。
    expect(
      agentHeaderState(status({ state: "done", updatedAt: at(0) })),
    ).toEqual({});
  });

  it("shows nothing for a restored `done`", () => {
    expect(
      agentHeaderState(
        status({
          state: "done",
          unread: true,
          restored: true,
          updatedAt: at(0),
        }),
      ),
    ).toEqual({});
  });

  /**
   * 合成收尾（20 分钟无回报 / 终端被杀）只是「让节点别再声称 RUNNING」。
   * Runtime 给它的判决是 `false` 且不置未读，所以它自己就落到「无胶囊」，
   * 显示侧不必特判。
   */
  it("puts no pill on a synthetic close", () => {
    for (const lastMessage of [
      "stale=true no hook report for 20 minutes",
      "terminated=true the terminal exited before the turn ended",
    ]) {
      const closed = {
        ...status({ state: "done", updatedAt: at(0) }),
        errored: false,
        interrupted: false,
        lastMessage,
      };
      expect(agentHeaderState(closed)).toEqual({});
    }
  });

  /**
   * Runtime 特意不让合成收尾清掉已有的未读：更早那个回合的输出仍然没人看过。
   * 终端死了不代表之前那次的结果不用看，所以 DONE 胶囊照出。
   */
  it("keeps an older turn's unread badge visible through a synthetic close", () => {
    expect(
      agentHeaderState({
        ...status({ state: "done", unread: true, updatedAt: at(0) }),
        errored: false,
        interrupted: false,
        lastMessage:
          "terminated=true the terminal exited before the turn ended",
      }),
    ).toEqual({
      pill: { tone: "unread", labelKey: "status.done" },
      glow: "unread",
    });
  });

  it("does not resurrect a mirror the terminal exit already dropped", () => {
    store().upsert(status({ state: "working", updatedAt: at(0) }), {
      now: BASE,
      remote: false,
    });
    store().handleEvent({
      type: "terminal.exit",
      sessionId: "s1",
      nodeId: NODE,
      exitCode: 137,
    });
    expect(scoped(NODE) in store().statuses).toBe(false);

    // 60s 后巡检补出来的合成收尾：终端早没了，镜像不该被它重新变出来。
    store().upsert(
      {
        ...status({ state: "done", updatedAt: at(60_000) }),
        errored: false,
        interrupted: false,
        lastMessage:
          "terminated=true the terminal exited before the turn ended",
      },
      { now: BASE + 60_000, remote: false },
    );
    expect(scoped(NODE) in store().statuses).toBe(false);
  });

  it("shows TURN FAILED and PAUSED when the runtime reports them", () => {
    expect(
      agentHeaderState({
        ...status({ state: "done", unread: true, updatedAt: at(0) }),
        errored: true,
      }),
    ).toEqual({
      pill: { tone: "failed", labelKey: "status.failed" },
      glow: "failed",
    });
    expect(
      agentHeaderState({
        ...status({ state: "done", updatedAt: at(0) }),
        interrupted: true,
      }),
    ).toEqual({
      pill: { tone: "paused", labelKey: "status.interrupted" },
    });
  });
});
