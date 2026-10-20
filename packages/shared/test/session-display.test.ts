import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PHASES,
  DETAIL_MAX_CHARS,
  STATUS_TONES,
  type ActivityPhase,
  type DisplayStatus,
  type SessionActivity,
  type SessionDisplayInput,
  agentHumanNeed,
  sessionDisplay,
  sessionSummarySchema,
} from "../src/index.js";

const act = (
  phase: ActivityPhase,
  extra: Partial<SessionActivity> = {},
): SessionActivity => ({ phase, since: 1_000, rev: "boot:1", ...extra });

const show = (input: SessionDisplayInput) => sessionDisplay(input);

describe("S1：出错 / 被打断的 done 不再画成绿色", () => {
  it("done + errored → failed；done + interrupted → paused；干净的 done 已读 → done", () => {
    expect(show({ status: { state: "done", errored: true } }).tone).toBe(
      "failed",
    );
    expect(
      show({ status: { state: "done", errored: true, unread: true } }).tone,
    ).toBe("failed");
    expect(show({ status: { state: "done", interrupted: true } }).tone).toBe(
      "paused",
    );
    expect(show({ status: { state: "done" } }).tone).toBe("done");
    expect(show({ status: { state: "done", unread: true } }).tone).toBe(
      "unread",
    );
  });
  it("重启后读回来的旧 done 不冒充刚跑完的未读，但失败的判决照出", () => {
    expect(
      show({ status: { state: "done", unread: true, restored: true } }).tone,
    ).toBe("done");
    expect(
      show({ status: { state: "done", errored: true, restored: true } }).tone,
    ).toBe("failed");
  });
});

describe("S2 / S3：出错只有一个口径", () => {
  it("tone=failed 看最近回合是否出错，need=error 还要未读", () => {
    const unread = show({
      status: { state: "done", errored: true, unread: true },
    });
    expect(unread).toMatchObject({
      tone: "failed",
      need: "error",
      labelKey: "status.failed",
    });
    const read = show({
      status: { state: "done", errored: true, unread: false },
    });
    expect(read).toMatchObject({ tone: "failed", need: null });
  });
  it("state=error 与 errored 同义；活动层的失败结局补上报缺的", () => {
    expect(show({ status: { state: "error", unread: true } })).toMatchObject({
      tone: "failed",
      need: "error",
    });
    const outcome = act("idle", {
      lastOutcome: { kind: "failed", at: 5, error: "x" },
    });
    expect(show({ activity: outcome, unread: true })).toMatchObject({
      tone: "failed",
      need: "error",
    });
    expect(show({ activity: outcome, unread: false })).toMatchObject({
      tone: "failed",
      need: null,
    });
  });
  it("新回合开始后，旧的失败结局不再压着现在的状态", () => {
    const running = act("tool", { lastOutcome: { kind: "failed", at: 5 } });
    expect(show({ activity: running })).toMatchObject({
      tone: "working",
      busy: true,
    });
  });
  it("拒答记 refused，上限记 limit，取消记 interrupted", () => {
    expect(
      show({
        activity: act("idle", { lastOutcome: { kind: "refused", at: 1 } }),
      }),
    ).toMatchObject({ tone: "failed", labelKey: "status.refused" });
    expect(
      show({
        activity: act("idle", { lastOutcome: { kind: "limit", at: 1 } }),
      }),
    ).toMatchObject({ tone: "paused", labelKey: "status.limit" });
    expect(
      show({
        activity: act("idle", { lastOutcome: { kind: "cancelled", at: 1 } }),
      }),
    ).toMatchObject({ tone: "paused", labelKey: "status.interrupted" });
    expect(
      show({
        activity: act("idle", { lastOutcome: { kind: "done", at: 1 } }),
        unread: true,
      }),
    ).toMatchObject({ tone: "unread", labelKey: "status.done" });
  });
});

describe("S4 / S8：进程已经没了就没有人能回答", () => {
  it.each(["blocked", "waiting"])(
    "%s 且 alive=false：need 为空，phase=exited，不再 attention",
    (state) => {
      const result = show({ status: { state, pendingId: "p" }, alive: false });
      expect(result).toMatchObject({
        need: null,
        phase: "exited",
        busy: false,
        labelKey: "status.exited",
      });
      expect(result.tone).not.toBe("attention");
    },
  );
  it("活着时 blocked → approval、waiting → input，attention", () => {
    expect(show({ status: { state: "blocked" }, alive: true })).toMatchObject({
      need: "approval",
      tone: "attention",
      phase: "awaiting_approval",
      busy: true,
    });
    expect(show({ status: { state: "waiting" } })).toMatchObject({
      need: "input",
      tone: "attention",
      phase: "awaiting_input",
    });
    expect(show({ status: { state: "working", pendingId: "p" } }).need).toBe(
      "approval",
    );
  });
  it("need 与 agentHumanNeed 同一个答案（推送、铃铛、面板都从这里取）", () => {
    for (const state of [
      undefined,
      "working",
      "waiting",
      "blocked",
      "done",
      "error",
    ]) {
      for (const alive of [undefined, true, false]) {
        for (const unread of [false, true]) {
          for (const errored of [undefined, false, true]) {
            const status: DisplayStatus = { state, errored, unread };
            expect(
              show({ status, alive }).need,
              JSON.stringify({ status, alive }),
            ).toBe(agentHumanNeed({ ...status, alive }));
          }
        }
      }
    }
  });
  it("生命周期阶段（启动、恢复、切换）进程未就绪也照实显示", () => {
    expect(
      show({
        activity: act("starting", { detail: { step: "initialize" } }),
        alive: false,
      }),
    ).toMatchObject({
      phase: "starting",
      tone: "queued",
      detail: "initialize",
      busy: false,
    });
  });
});

describe("S5：程序自报在函数内部合并", () => {
  it("没有上报时，程序自报画状态；blocked 的 question 是 input，其余是 approval", () => {
    expect(show({ program: { state: "working", progress: 40 } })).toMatchObject(
      { tone: "working", busy: true, progress: 40, labelKey: "status.working" },
    );
    expect(
      show({ program: { state: "blocked", kind: "permission" } }),
    ).toMatchObject({ need: "approval", tone: "attention" });
    expect(
      show({ program: { state: "blocked", kind: "question" } }),
    ).toMatchObject({ need: "input" });
    expect(show({ program: { state: "blocked", kind: "auth" } })).toMatchObject(
      { need: "approval" },
    );
    expect(show({ program: { state: "done" }, unread: true })).toMatchObject({
      tone: "unread",
    });
    expect(show({ program: { state: "error" }, unread: true })).toMatchObject({
      tone: "failed",
      need: "error",
    });
    expect(show({ program: { state: "idle" } })).toMatchObject({
      tone: "idle",
      phase: "unknown",
    });
  });
  it("有活的上报时上报说了算，程序自报只补进度", () => {
    const result = show({
      status: { state: "done" },
      program: { state: "working", progress: 10 },
    });
    expect(result).toMatchObject({ tone: "done", busy: false });
    expect(result.progress).toBeUndefined();
    expect(
      show({
        status: { state: "working" },
        program: { state: "working", progress: 10 },
      }).progress,
    ).toBe(10);
    expect(
      show({ status: { state: "working" }, program: { state: "blocked" } })
        .need,
    ).toBeNull();
  });
  it("旧行（restored）和猜测（observed）不算活的上报，程序自报接管", () => {
    expect(
      show({
        status: { state: "done", restored: true },
        program: { state: "working" },
      }).tone,
    ).toBe("working");
    expect(
      show({
        status: { state: "working", stateSource: "observed" },
        program: { state: "blocked" },
      }).need,
    ).toBe("approval");
  });
  it("有活动时程序自报不参与", () => {
    expect(
      show({ activity: act("idle"), program: { state: "working" } }),
    ).toMatchObject({ tone: "idle", busy: false });
  });
});

describe("S6 / S7：同一输入同一色调，冷启动和实时同一个结果", () => {
  it("纯函数：同一输入两次相同，不依赖当前时间", () => {
    const input: SessionDisplayInput = {
      status: { state: "working" },
      activity: act("tool", { detail: { label: "Read a.ts" } }),
      alive: true,
    };
    expect(show(input)).toEqual(show({ ...input }));
  });
  it("没有任何信息：tone idle，phase unknown，label status.unknown", () => {
    expect(show({})).toEqual({
      tone: "idle",
      phase: "unknown",
      labelKey: "status.unknown",
      need: null,
      busy: false,
    });
  });
});

describe("活动阶段 → 显示", () => {
  const expected: Record<
    ActivityPhase,
    { tone: string; busy: boolean; labelKey: string }
  > = {
    starting: { tone: "queued", busy: false, labelKey: "status.starting" },
    restoring: { tone: "queued", busy: false, labelKey: "status.restoring" },
    idle: { tone: "idle", busy: false, labelKey: "status.idle" },
    submitting: { tone: "working", busy: true, labelKey: "status.submitting" },
    thinking: { tone: "working", busy: true, labelKey: "status.thinking" },
    tool: { tone: "working", busy: true, labelKey: "status.tool" },
    awaiting_approval: {
      tone: "attention",
      busy: true,
      labelKey: "status.awaitingApproval",
    },
    awaiting_input: {
      tone: "attention",
      busy: true,
      labelKey: "status.awaitingInput",
    },
    responding: { tone: "working", busy: true, labelKey: "status.responding" },
    switching: { tone: "queued", busy: false, labelKey: "status.switching" },
    sleeping: { tone: "idle", busy: false, labelKey: "status.sleeping" },
    exited: { tone: "idle", busy: false, labelKey: "status.exited" },
  };
  it.each(ACTIVITY_PHASES)("%s", (phase) => {
    const result = show({ activity: act(phase), alive: true });
    const want = expected[phase];
    expect(result.phase).toBe(phase);
    expect(result.busy).toBe(want.busy);
    expect(result.labelKey).toBe(want.labelKey);
    if (phase === "sleeping") expect(result.tone).toBe("idle");
    else expect(result.tone).toBe(want.tone);
    if (phase === "awaiting_approval") expect(result.need).toBe("approval");
    if (phase === "awaiting_input") expect(result.need).toBe("input");
  });
  it("休眠标志：paused，不 busy，不要人", () => {
    expect(
      show({ activity: act("tool"), sleeping: true, alive: false }),
    ).toMatchObject({
      tone: "paused",
      phase: "sleeping",
      busy: false,
      need: null,
    });
    expect(
      show({ status: { state: "blocked" }, sleeping: true }),
    ).toMatchObject({ need: null, tone: "paused" });
  });
  it("进程死了但活动还停在工具上：显示已退出", () => {
    expect(show({ activity: act("tool"), alive: false })).toMatchObject({
      phase: "exited",
      busy: false,
      tone: "idle",
    });
  });
  it("细节：工具标题、回放条数；截到 60 字；since 取活动的进入时间", () => {
    expect(
      show({
        activity: act("tool", {
          detail: { label: "pnpm test", toolKind: "execute", count: 2 },
        }),
      }),
    ).toMatchObject({ detail: "pnpm test", since: 1_000 });
    expect(
      show({ activity: act("restoring", { detail: { count: 120 } }) }).detail,
    ).toBe("120");
    expect(
      show({ activity: act("restoring", { detail: { count: 0 } }) }).detail,
    ).toBeUndefined();
    const long = show({
      activity: act("tool", { detail: { label: "字".repeat(100) } }),
    }).detail;
    expect(Array.from(long ?? "")).toHaveLength(DETAIL_MAX_CHARS);
    expect(long?.endsWith("…")).toBe(true);
    expect(
      show({ activity: act("tool", { detail: { label: "  " } }) }).detail,
    ).toBeUndefined();
  });
  it("需要审批覆盖活动阶段：活动还说在跑工具，上报已经 blocked", () => {
    expect(
      show({
        activity: act("tool", { detail: { label: "x" } }),
        status: { state: "blocked" },
      }),
    ).toMatchObject({
      phase: "awaiting_approval",
      tone: "attention",
      need: "approval",
    });
  });
});

describe("粗状态（没有活动，终端驱动）", () => {
  it("working → unknown 阶段但在忙；done → idle", () => {
    expect(show({ status: { state: "working" } })).toMatchObject({
      phase: "unknown",
      busy: true,
      tone: "working",
      labelKey: "status.working",
    });
    expect(show({ status: { state: "done" } })).toMatchObject({
      phase: "idle",
      busy: false,
      labelKey: "status.done",
    });
  });
  it("进程死了：exited", () => {
    expect(show({ status: { state: "done" }, alive: false })).toMatchObject({
      phase: "exited",
      labelKey: "status.exited",
      tone: "done",
    });
  });
});

describe("全组合不变量", () => {
  const statuses: (DisplayStatus | undefined)[] = [
    undefined,
    { state: "working" },
    { state: "waiting" },
    { state: "blocked" },
    { state: "working", pendingId: "p" },
    { state: "done" },
    { state: "done", errored: true },
    { state: "done", interrupted: true },
    { state: "done", restored: true, unread: true },
    { state: "error" },
    { state: "working", stateSource: "observed" },
  ];
  const activities: (SessionActivity | undefined)[] = [
    undefined,
    ...ACTIVITY_PHASES.map((phase) => act(phase)),
    act("idle", { lastOutcome: { kind: "failed", at: 1 } }),
    act("idle", { lastOutcome: { kind: "cancelled", at: 1 } }),
    act("idle", { lastOutcome: { kind: "done", at: 1 } }),
  ];
  const programs: SessionDisplayInput["program"][] = [
    undefined,
    { state: "working", progress: 5 },
    { state: "blocked", kind: "question" },
    { state: "error" },
  ];
  const inputs: SessionDisplayInput[] = [];
  for (const status of statuses)
    for (const activity of activities)
      for (const alive of [undefined, true, false])
        for (const sleeping of [false, true])
          for (const unread of [undefined, false, true])
            for (const program of programs)
              inputs.push({
                status,
                activity,
                alive,
                sleeping,
                unread,
                program,
              });

  it(`${inputs.length} 种输入全部满足不变量`, () => {
    expect(inputs.length).toBeGreaterThan(5_000);
    const seenTones = new Set<string>();
    for (const input of inputs) {
      const r = show(input);
      const label = JSON.stringify(input);
      seenTones.add(r.tone);
      expect(STATUS_TONES, label).toContain(r.tone);
      expect(r.labelKey, label).toMatch(/^status\.[a-zA-Z]+$/);
      expect(show(input), label).toEqual(r);
      // 进程死了（且不是生命周期阶段）：没人能答，不在忙。
      const lifecycle =
        input.activity &&
        ["starting", "restoring", "switching", "sleeping", "exited"].includes(
          input.activity.phase,
        );
      if (input.alive === false) {
        expect(r.need === "approval" || r.need === "input", label).toBe(false);
        if (!lifecycle && !input.sleeping) {
          expect(r.busy, label).toBe(false);
          expect(r.phase, label).toBe("exited");
        }
      }
      // 休眠：不忙，不要人答。
      if (input.sleeping) {
        expect(r.busy, label).toBe(false);
        expect(r.phase, label).toBe("sleeping");
        expect(r.need === "approval" || r.need === "input", label).toBe(false);
      }
      // 要人答 ⇒ attention；忙 ⇒ working / attention。
      if (r.need === "approval" || r.need === "input")
        expect(r.tone, label).toBe("attention");
      if (r.tone === "attention")
        expect(r.need === "approval" || r.need === "input", label).toBe(true);
      if (r.busy) expect(["working", "attention"], label).toContain(r.tone);
      // 出错未读 ⇒ failed；新回合在跑或会话正在启动 / 恢复 / 切换时，那件事优先。
      if (r.need === "error" && !r.busy && r.tone !== "queued")
        expect(r.tone, label).toBe("failed");
      // 只有没有活动时才会是 unknown 阶段。
      if (r.phase === "unknown") expect(input.activity, label).toBeUndefined();
      // 有活动且没被覆盖：阶段就是活动的阶段。
      if (
        input.activity &&
        !input.sleeping &&
        !r.need &&
        !(input.alive === false)
      ) {
        expect(r.phase, label).toBe(input.activity.phase);
      }
      // busy 取代各处自己的判断：忙就一定有阶段或粗状态在忙。
      if (r.busy)
        expect(
          r.phase === "unknown" ||
            [
              "submitting",
              "thinking",
              "tool",
              "awaiting_approval",
              "awaiting_input",
              "responding",
            ].includes(r.phase),
          label,
        ).toBe(true);
    }
    // 八种色调都出现过。
    expect([...seenTones].sort()).toEqual([...STATUS_TONES].sort());
  });

  it("没有活动与程序自报时，need 只由粗状态和 alive 决定（与 agentHumanNeed 一致）", () => {
    for (const input of inputs) {
      if (input.activity || input.program || input.sleeping) continue;
      const r = show(input);
      const unread = input.unread ?? input.status?.unread;
      expect(r.need, JSON.stringify(input)).toBe(
        agentHumanNeed({
          state: input.status?.state,
          pendingId: input.status?.pendingId,
          errored: input.status?.errored,
          unread,
          alive: input.alive,
        }),
      );
    }
  });
});

describe("sessionSummarySchema", () => {
  it("可省的 activity 与 timelineSeq；旧客户端的摘要照常解析", () => {
    const base = {
      nodeId: "n",
      boardId: "b",
      sessionId: "s",
      kind: "terminal" as const,
      title: "t",
      cwd: "/",
      updatedAt: "2026-10-20T00:00:00.000Z",
      alive: true,
    };
    expect(sessionSummarySchema.safeParse(base).success).toBe(true);
    const full = sessionSummarySchema.parse({
      ...base,
      activity: act("tool"),
      timelineSeq: 12,
    });
    expect(full.activity?.phase).toBe("tool");
    expect(full.timelineSeq).toBe(12);
    expect(
      sessionSummarySchema.safeParse({ ...base, activity: { phase: "zzz" } })
        .success,
    ).toBe(false);
  });
});
