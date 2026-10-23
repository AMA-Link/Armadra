import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_STATES,
  type AgentStatus,
  type ProgramStatus,
  type SessionSummary,
} from "@armadra/shared";

import { notificationFor } from "../app/notifications";
import {
  MINIMAP_COLORS,
  minimapItemOf,
  minimapStroke,
} from "../canvas/flow/Minimap";
import { collectNeeds } from "../notifications/needs";
import { boardSignals } from "../sidebar/board-tree";
import { scoped } from "../sources/scope";
import { t } from "../app/preferences-store";
import { StatusDot, StatusLine, StatusPill } from "../ui/status-pill";
import {
  NEED_TONE,
  STATUS_LABEL_KEYS,
  displayOfRow,
  displayOfStatus,
  lineOf,
} from "./display";
import { headerStateFor } from "./program-status-store";
import { mergeSessions, sessionBucket, type SessionRow } from "./sessions";
import { useAgentStatusStore, type MirroredStatus } from "./status-store";

/**
 * 状态显示一致性（acp-progressive-view §1.3，S1–S11）。
 *
 * 同一个状态从每个视图的真实入口走一遍——节点头（`headerStateFor`）、侧栏
 * （`mergeSessions` → `sessionBucket` / `displayOfRow`）、抽屉（`displayOfStatus`）、
 * 铃铛（`collectNeeds`）、系统通知（`notificationFor`）、小地图（`minimapStroke`）——
 * 断言它们说的是同一件事。任何一个视图再自己推导，这里就会有一格对不上。
 */

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";
const AT = "2026-10-20T10:00:00.000Z";

function mirrored(partial: Partial<MirroredStatus>): MirroredStatus {
  return {
    nodeId: NODE,
    workspaceId: WORKSPACE,
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: AT,
    ...partial,
  };
}

function summaryOf(status: MirroredStatus, alive: boolean): SessionSummary {
  return {
    nodeId: NODE,
    boardId: "b1",
    sessionId: "s1",
    kind: "terminal",
    title: "Agent",
    cwd: "/repo",
    agentId: "claude",
    unread: false,
    updatedAt: status.updatedAt,
    alive,
  } as SessionSummary;
}

/** 一个状态在每个视图里的样子。 */
function surfaces(
  status: MirroredStatus,
  options: { alive?: boolean; program?: ProgramStatus } = {},
) {
  const alive = options.alive ?? true;
  const withAlive: MirroredStatus = { ...status, alive };
  const programs = options.program ? { [scoped(NODE)]: options.program } : {};
  const [row] = mergeSessions(
    [summaryOf(status, alive)],
    { [scoped(NODE)]: withAlive },
    Date.parse(AT),
    programs,
  ) as [SessionRow];
  const header = headerStateFor(true, withAlive, options.program);
  const needs = collectNeeds([
    { workspaceId: WORKSPACE, rows: [row], handoffs: [] },
  ]);
  return {
    row,
    header,
    sidebar: displayOfRow(row),
    drawer: displayOfStatus(withAlive, options.program),
    bucket: sessionBucket(row),
    bell: needs[0]?.need ?? null,
    notification: notificationFor(undefined, withAlive as AgentStatus),
    minimap: minimapStroke(
      minimapItemOf(
        { id: NODE, type: "armadra", selected: false },
        () => header.glow,
      ),
    ),
    signals: boardSignals([row]),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAgentStatusStore.getState().reset();
});

describe("同一个状态，每个视图说同一句话（矩阵）", () => {
  const states = [undefined, ...AGENT_STATES] as const;
  const flags = [false, true] as const;

  for (const state of states) {
    for (const unread of flags) {
      for (const errored of flags) {
        for (const interrupted of flags) {
          for (const alive of flags) {
            for (const pending of flags) {
              const name = JSON.stringify({
                state,
                unread,
                errored,
                interrupted,
                alive,
                pending,
              });
              it(name, () => {
                const status = mirrored({
                  ...(state ? { state } : {}),
                  unread,
                  ...(errored ? { errored } : {}),
                  ...(interrupted ? { interrupted } : {}),
                  ...(pending ? { pendingId: "p1" } : {}),
                });
                const seen = surfaces(status, { alive });

                // 色调：节点头、侧栏、抽屉同一个。
                expect(seen.sidebar.tone).toBe(seen.drawer.tone);
                expect(seen.header.display?.tone).toBe(seen.drawer.tone);
                // 要人处理：铃铛、系统通知、侧栏、节点头同一个，进程已死不算。
                expect(seen.bell).toBe(seen.drawer.need);
                expect(seen.header.display?.need).toBe(seen.drawer.need);
                expect(seen.notification).toBe(seen.drawer.need);
                if (!alive) expect(seen.drawer.need).toBeNull();
                // 回合在跑：侧栏分区、节点头光晕、抽屉是同一个 `busy`。
                expect(seen.bucket === "working").toBe(
                  (seen.drawer.busy || seen.drawer.tone === "queued") &&
                    seen.drawer.tone !== "attention",
                );
                expect(seen.header.glow === "working").toBe(
                  seen.drawer.tone === "working",
                );
                // 要你处理的节点：分区、板信号、光晕都认。
                const attention = seen.drawer.tone === "attention";
                expect(seen.bucket === "attention").toBe(attention);
                expect(seen.header.glow === "attention").toBe(attention);
                expect(seen.minimap === MINIMAP_COLORS.attention).toBe(
                  attention,
                );
                expect(seen.signals.b1?.attention ?? false).toBe(
                  alive && attention,
                );
              });
            }
          }
        }
      }
    }
  }
});

describe("S1 出错的回合不再画成绿色", () => {
  it("done + errored：侧栏是失败色，不是完成色；被打断是暂停色", () => {
    const failed = surfaces(
      mirrored({ state: "done", errored: true, unread: true }),
    );
    expect(failed.sidebar.tone).toBe("failed");
    expect(failed.sidebar.tone).not.toBe("done");
    expect(failed.header.pill?.tone).toBe("failed");
    expect(failed.bucket).toBe("unread");

    const paused = surfaces(mirrored({ state: "done", interrupted: true }));
    expect(paused.sidebar.tone).toBe("paused");
    expect(paused.header.pill?.tone).toBe("paused");
  });

  it("干净完成才是完成色", () => {
    const clean = surfaces(mirrored({ state: "done" }));
    expect(clean.sidebar.tone).toBe("done");
    expect(clean.header.pill).toBeUndefined();
  });
});

describe("S2 抽屉与别处同一个判据", () => {
  it("抽屉看 unread 与 alive：读过的失败与已死的审批不再冒充", () => {
    const dead = surfaces(mirrored({ state: "blocked", pendingId: "p" }), {
      alive: false,
    });
    expect(dead.drawer.tone).not.toBe("attention");
    expect(dead.drawer.need).toBeNull();

    const read = surfaces(mirrored({ state: "done", errored: true }));
    expect(read.drawer.tone).toBe("failed");
    expect(read.drawer.need).toBeNull();
    expect(read.bell).toBeNull();
  });
});

describe("S3 出错只有一个口径", () => {
  it("tone = failed 看回合，need = error 还要没人看过", () => {
    const unread = surfaces(
      mirrored({ state: "done", errored: true, unread: true }),
    );
    const read = surfaces(mirrored({ state: "done", errored: true }));
    for (const one of [unread, read]) {
      expect(one.header.pill?.tone).toBe("failed");
      expect(one.sidebar.tone).toBe("failed");
      expect(one.drawer.tone).toBe("failed");
    }
    // 铃铛、通知只收没看过的。
    expect([unread.bell, unread.notification]).toEqual(["error", "error"]);
    expect([read.bell, read.notification]).toEqual([null, null]);
    // 小地图：没看过画失败色（不再是品牌色），看过就不描边。
    expect(unread.minimap).toBe(MINIMAP_COLORS.failed);
    expect(unread.minimap).not.toBe(MINIMAP_COLORS.unread);
    expect(read.minimap).toBe(MINIMAP_COLORS.plain);
  });
});

describe("S4 进程已死不再「需要你」", () => {
  it("节点头、铃铛、侧栏一起不认；等待回答在节点头有胶囊", () => {
    const dead = surfaces(mirrored({ state: "blocked", pendingId: "p" }), {
      alive: false,
    });
    expect(dead.header.pill?.tone).not.toBe("attention");
    expect(dead.header.glow).toBeUndefined();
    expect(dead.bell).toBeNull();
    expect(dead.bucket).not.toBe("attention");

    const asking = surfaces(mirrored({ state: "waiting" }));
    expect(asking.header.pill).toMatchObject({
      tone: "attention",
      labelKey: "status.awaitingInput",
    });
    expect(asking.bell).toBe("input");
  });
});

describe("S5 程序自报在每个视图里合并", () => {
  const blocked: ProgramStatus = {
    state: "blocked",
    kind: "permission",
    source: "osc7501",
    updatedAt: AT,
  };

  it("没有活的上报时，节点头、侧栏、抽屉、铃铛都按程序自报算", () => {
    // 重启后读回来的旧行不算活的上报。
    const seen = surfaces(mirrored({ state: "done", restored: true }), {
      program: blocked,
    });
    expect(seen.header.display?.tone).toBe("attention");
    expect(seen.sidebar.tone).toBe("attention");
    expect(seen.drawer.tone).toBe("attention");
    expect(seen.bucket).toBe("attention");
    expect(seen.bell).toBe("approval");
    expect(seen.minimap).toBe(MINIMAP_COLORS.attention);
  });

  it("有活的上报时上报说了算", () => {
    const seen = surfaces(mirrored({ state: "working" }), { program: blocked });
    expect(seen.sidebar.tone).toBe("working");
    expect(seen.bell).toBeNull();
  });
});

describe("S6 同一个条件同一个色调", () => {
  it("通知面板的色调就是同一状态的胶囊色调", () => {
    const cases = {
      approval: surfaces(mirrored({ state: "blocked", pendingId: "p" })),
      input: surfaces(mirrored({ state: "waiting" })),
      error: surfaces(mirrored({ state: "done", errored: true, unread: true })),
    } as const;
    for (const [need, one] of Object.entries(cases)) {
      expect(one.bell).toBe(need);
      expect(NEED_TONE[need as keyof typeof NEED_TONE]).toBe(one.drawer.tone);
      expect(one.header.pill?.tone).toBe(one.drawer.tone);
    }
  });
});

describe("S7 铃铛与侧栏用同一份数据同一个函数", () => {
  it("同一批会话行：铃铛收的节点就是显示结果里 need 非空的节点", () => {
    const rows = [
      surfaces(mirrored({ nodeId: "a", state: "blocked" })).row,
      surfaces(mirrored({ nodeId: "b", state: "waiting" })).row,
      surfaces(mirrored({ nodeId: "c", state: "working" })).row,
      surfaces(mirrored({ nodeId: "d", state: "done", errored: true })).row,
      surfaces(
        mirrored({ nodeId: "e", state: "done", errored: true, unread: true }),
      ).row,
    ].map((row, index) => ({ ...row, nodeId: "abcde"[index]! }));
    const bell = collectNeeds([
      { workspaceId: WORKSPACE, rows, handoffs: [] },
    ]).map((item) => item.nodeId);
    const byDisplay = rows
      .filter((row) => displayOfRow(row).need !== null)
      .map((row) => row.nodeId);
    expect(bell.sort()).toEqual(byDisplay.sort());
    expect(bell.sort()).toEqual(["a", "b", "e"]);
  });
});

describe("S8 通知去重按显示结果", () => {
  it("进入同一种需要只提醒一次，进程已死不提醒", () => {
    const first = mirrored({ state: "waiting" });
    expect(notificationFor(undefined, first)).toBe("input");
    expect(notificationFor(first, first)).toBeNull();
    expect(
      notificationFor(undefined, { ...first, alive: false } as AgentStatus),
    ).toBeNull();
    expect(notificationFor(undefined, { ...first, restored: true })).toBeNull();
  });
});

describe("S9 挂起的审批只有 core 这一份", () => {
  it("页面没有计时器：时间过去多久，pendingId 都以 core 的帧为准", () => {
    vi.useFakeTimers();
    const store = useAgentStatusStore.getState();
    store.upsert(
      mirrored({ state: "blocked", pendingId: "p1" }) as AgentStatus,
      { remote: false },
    );
    vi.advanceTimersByTime(60 * 60_000);
    const held = useAgentStatusStore.getState().statuses[scoped(NODE)]!;
    expect(held.pendingId).toBe("p1");
    expect(displayOfStatus(held).need).toBe("approval");

    // core 清掉 pendingId 的帧一到，节点头与会话视图读到同一个结果。
    store.upsert(
      mirrored({
        state: "blocked",
        updatedAt: new Date(Date.parse(AT) + 1_000).toISOString(),
      }) as AgentStatus,
      { remote: false },
    );
    const dropped = useAgentStatusStore.getState().statuses[scoped(NODE)]!;
    expect(dropped.pendingId).toBeUndefined();
  });
});

describe("S10 「回合在跑」只有一种推导", () => {
  it("上报 working 与活动阶段给出同一个 busy，进程已死都不算", () => {
    expect(surfaces(mirrored({ state: "working" })).drawer.busy).toBe(true);
    const tool = displayOfStatus({
      ...mirrored({ state: "working" }),
      activity: {
        phase: "tool",
        since: 1,
        rev: "boot:1",
      },
    });
    expect(tool.busy).toBe(true);
    expect(tool.labelKey).toBe("status.tool");
    expect(
      surfaces(mirrored({ state: "working" }), { alive: false }).drawer.busy,
    ).toBe(false);
  });

  it("活动按 rev 判断先后，core 重启后取后到的", () => {
    const store = useAgentStatusStore.getState();
    store.upsert(mirrored({ state: "working" }) as AgentStatus, {
      remote: false,
    });
    const activity = (phase: "thinking" | "tool", rev: string) => ({
      phase,
      since: 1,
      rev,
    });
    store.setActivity(NODE, activity("tool", "boot:5"));
    store.setActivity(NODE, activity("thinking", "boot:4"));
    expect(
      useAgentStatusStore.getState().statuses[scoped(NODE)]?.activity?.phase,
    ).toBe("tool");
    store.setActivity(NODE, activity("thinking", "boot2:1"));
    expect(
      useAgentStatusStore.getState().statuses[scoped(NODE)]?.activity?.phase,
    ).toBe("thinking");
  });
});

describe("S11 状态词汇只有一份", () => {
  it("共享层的每个状态都能画出一个色调", () => {
    for (const state of AGENT_STATES) {
      const seen = surfaces(mirrored({ state }));
      expect(seen.drawer.tone).toBeDefined();
    }
  });
});

describe("文案键", () => {
  it("显示结果给出的每个 labelKey 都在列表里", () => {
    const keys = new Set<string>(STATUS_LABEL_KEYS);
    const phases = [
      "starting",
      "restoring",
      "idle",
      "submitting",
      "thinking",
      "tool",
      "awaiting_approval",
      "awaiting_input",
      "responding",
      "switching",
      "sleeping",
      "exited",
    ] as const;
    for (const phase of phases) {
      const display = displayOfStatus({
        ...mirrored({ state: "working" }),
        activity: { phase, since: 1, rev: "b:1" },
      });
      expect(keys.has(display.labelKey)).toBe(true);
    }
  });
});

describe("S12 点、胶囊、行三种形态，同一个 tone 同一句文案", () => {
  const states = [undefined, ...AGENT_STATES] as const;

  for (const state of states) {
    for (const alive of [true, false] as const) {
      it(`${state ?? "无上报"} / alive=${alive}`, () => {
        const display = displayOfStatus({
          ...mirrored({ ...(state ? { state } : {}), unread: true }),
          alive,
        });
        const line = lineOf(display, undefined, t);
        const { container } = render(
          createElement(
            "div",
            null,
            createElement(StatusDot, {
              tone: line.tone,
              label: line.phaseLabel,
            }),
            createElement(StatusPill, {
              tone: line.tone,
              label: line.phaseLabel,
            }),
            createElement(StatusLine, {
              tone: line.tone,
              label: line.phaseLabel,
              detail: line.detail,
              spinning: line.spinning,
            }),
          ),
        );
        const dot = container.querySelector("[data-slot=status-dot]")!;
        const pill = container.querySelector("[data-slot=status-pill]")!;
        const row = container.querySelector("[data-slot=status-line]")!;
        // 同一个 tone
        expect(line.tone).toBe(display.tone);
        expect(dot.getAttribute("data-tone")).toBe(display.tone);
        expect(pill.getAttribute("data-tone")).toBe(display.tone);
        expect(row.getAttribute("data-tone")).toBe(display.tone);
        // 同一句文案：点的无障碍名、胶囊文字、行里的阶段
        const phase = row.querySelector("[data-slot=status-line-phase]")!;
        expect(line.phaseLabel).toBe(t(display.labelKey));
        expect(dot.getAttribute("aria-label")).toBe(line.phaseLabel);
        expect(pill.textContent).toBe(line.phaseLabel);
        expect(phase.textContent).toBe(line.phaseLabel);
      });
    }
  }

  it("只有「在跑」转圈；等审批、出错、已完成都不转", () => {
    const spin = (state: (typeof AGENT_STATES)[number], extra = {}) =>
      lineOf(
        displayOfStatus({ ...mirrored({ state, ...extra }), alive: true }),
        undefined,
        t,
      ).spinning;
    expect(spin("working")).toBe(true);
    expect(spin("blocked", { pendingId: "p" })).toBe(false);
    expect(spin("done", { errored: true })).toBe(false);
    expect(spin("done")).toBe(false);
  });

  it("计时取活动阶段的开始时间", () => {
    const display = displayOfStatus({
      ...mirrored({ state: "working" }),
      activity: { phase: "tool", since: 1234, rev: "b:1" },
    });
    expect(lineOf(display, undefined, t).since).toBe(1234);
  });
});
