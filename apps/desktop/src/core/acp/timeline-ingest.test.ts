import { afterEach, describe, expect, it } from "vitest";

import type { SessionActivity, TimelineItem } from "@armadra/shared";

import type { WorkspaceEvent } from "../bus";
import { type TimelineDomain, install as installTimeline } from "../timeline";
import { AcpFeed } from "./feed";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";

/**
 * B3：ACP 会话接到时间线与活动（契约 §82）。真管理器 + 假 ACP Agent（真子进程）
 * 走整条链路；图片、diff、工具中间状态这些假 Agent 不会发的，直接对 `AcpFeed`
 * 喂脚本化的 `session/update`。
 */

let open: AcpCore | undefined;
let domain: TimelineDomain;
let seen: WorkspaceEvent[];

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

async function boot(): Promise<void> {
  open = await acpCore();
  domain = installTimeline(open.core) as TimelineDomain;
  seen = [];
  open.core.bus.on("workspace.event", ({ event }) => seen.push(event));
}

async function start(prompt?: string) {
  const nodeId = await open!.node();
  const created = await open!.core.call("POST", "/api/acp/sessions", {
    workspaceId: open!.workspaceId,
    nodeId,
    cwd: open!.core.directory,
    agentId: FAKE_AGENT,
    ...(prompt === undefined ? {} : { prompt }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { nodeId, rowId: (created.body as { id: string }).id };
}

function items(rowId: string): TimelineItem[] {
  domain.writer.flush();
  return domain.store.snapshot(rowId, 20)?.items ?? [];
}

function kinds(rowId: string): string[] {
  return items(rowId).map((item) => item.kind);
}

const turnsEnded = () => seen.filter((event) => event.type === "acp.turn");

const activities = (rowId: string): SessionActivity[] =>
  seen.flatMap((event) =>
    event.type === "timeline.activity" && event.timelineId === rowId
      ? [event.activity as SessionActivity]
      : [],
  );

describe("一个完整的回合", () => {
  it("思考、计划、文本、回合结束都进时间线，序号连续，活动回到 idle", async () => {
    await boot();
    const { rowId } = await start("hello [think] [plan]");
    await until(turnsEnded, (turns) => turns.length > 0);
    const all = items(rowId);
    expect(all.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["turn", "user", "thought", "plan", "assistant"]),
    );
    const turn = all.find((item) => item.kind === "turn");
    expect(turn).toMatchObject({ stopReason: "end_turn" });
    expect(all.find((item) => item.kind === "user")).toMatchObject({
      text: expect.stringContaining("hello"),
    });
    // timeline.delta 帧首尾相接：from 等于上一帧的 to。
    const frames = seen.filter(
      (event) => event.type === "timeline.delta" && event.timelineId === rowId,
    ) as unknown as { from: number; to: number }[];
    expect(frames.length).toBeGreaterThan(0);
    frames.reduce((previous, frame) => {
      expect(frame.from).toBe(previous);
      return frame.to;
    }, 0);
    const phases = activities(rowId).map((activity) => activity.phase);
    expect(phases).toEqual(
      expect.arrayContaining(["starting", "submitting", "idle"]),
    );
    expect(domain.activityOf(rowId)).toMatchObject({
      phase: "idle",
      lastOutcome: { kind: "done" },
    });
  });

  it("启动各阶段先于会话可用出现在活动里", async () => {
    await boot();
    const { rowId } = await start();
    const steps = activities(rowId)
      .filter((activity) => activity.phase === "starting")
      .map((activity) => activity.detail?.step);
    expect(steps).toEqual(
      expect.arrayContaining(["spawn", "initialize", "session", "configure"]),
    );
  });

  it("拒答记 refused，回合条目带停止原因", async () => {
    await boot();
    const { rowId } = await start("no [refuse]");
    await until(turnsEnded, (turns) => turns.length > 0);
    expect(items(rowId).find((i) => i.kind === "turn")).toMatchObject({
      stopReason: "refusal",
    });
    expect(domain.activityOf(rowId)?.lastOutcome?.kind).toBe("refused");
  });
});

describe("审批", () => {
  it("答复：审批条目 answered，工具上记 allowed，等待时间计入回合", async () => {
    await boot();
    const { rowId } = await start("write [permission]");
    const asked = await until(
      () => seen.find((e) => e.type === "agent.approval"),
      (e) => e !== undefined,
    );
    const pendingId = (asked as { pendingId: string }).pendingId;
    expect(items(rowId).find((i) => i.kind === "approval")).toMatchObject({
      id: `ap:${pendingId}`,
      state: "pending",
    });
    expect(domain.activityOf(rowId)?.phase).toBe("awaiting_approval");
    await open!.core.call("POST", `/api/approvals/${pendingId}/answer`, {
      decision: "allow",
    });
    await until(turnsEnded, (turns) => turns.length > 0);
    const all = items(rowId);
    expect(all.find((i) => i.kind === "approval")).toMatchObject({
      state: "answered",
      answer: { optionId: "allow" },
    });
    expect(all.find((i) => i.kind === "tool")).toMatchObject({
      permission: { pendingId, outcome: "allowed", optionId: "allow" },
    });
  });

  it("取消回合：审批 cancelled，工具 cancelled，结局 cancelled", async () => {
    await boot();
    const { rowId } = await start("write [permission]");
    await until(
      () => seen.find((e) => e.type === "agent.approval"),
      (e) => e !== undefined,
    );
    await open!.core.call("POST", `/api/acp/sessions/${rowId}/cancel`);
    await until(turnsEnded, (turns) => turns.length > 0);
    const all = items(rowId);
    expect(all.find((i) => i.kind === "approval")).toMatchObject({
      state: "cancelled",
    });
    expect(all.find((i) => i.kind === "turn")).toMatchObject({
      stopReason: "cancelled",
    });
    expect(domain.activityOf(rowId)?.lastOutcome?.kind).toBe("cancelled");
  });

  it("提问：elicitation 条目挂起，取消后 cancelled", async () => {
    await boot();
    const { rowId } = await start("pick [elicit]");
    await until(
      () => items(rowId).find((i) => i.kind === "elicitation"),
      (i) => i !== undefined,
    );
    expect(domain.activityOf(rowId)?.phase).toBe("awaiting_input");
    await open!.core.call("POST", `/api/acp/sessions/${rowId}/cancel`);
    await until(turnsEnded, (turns) => turns.length > 0);
    expect(items(rowId).find((i) => i.kind === "elicitation")).toMatchObject({
      state: "cancelled",
    });
  });
});

describe("崩溃", () => {
  it("适配器在回合中被杀：回合记错误，活动 exited，时间线有 exited 提示", async () => {
    await boot();
    const { rowId } = await start("wait [slow]");
    await until(
      () => domain.activityOf(rowId)?.phase,
      (phase) => phase !== undefined && phase !== "starting",
    );
    const { acpTerminal } = await import(".");
    const session = acpTerminal()?.backend.sessionByRow(rowId);
    expect(session?.pid).toBeGreaterThan(0);
    process.kill(session!.pid as number, "SIGKILL");
    await until(
      () => domain.activityOf(rowId)?.phase,
      (phase) => phase === "exited",
    );
    const all = items(rowId);
    expect(all.find((i) => i.kind === "turn")?.kind).toBe("turn");
    expect(all.some((i) => i.kind === "notice" && i.code === "exited")).toBe(
      true,
    );
  });
});

describe("脚本化的 session/update（AcpFeed）", () => {
  function feedOf(rowId = "row-synthetic") {
    const feed = new AcpFeed(domain, {
      rowId,
      nodeId: "node-synthetic",
      workspaceId: open!.workspaceId,
      generation: 1,
    });
    return { feed, rowId };
  }

  it("图片落成 blob，条目里没有 base64；工具中间状态与 diff 按 toolCallId 合并", async () => {
    await boot();
    const { feed, rowId } = feedOf();
    feed.beginTurn("1-1", { text: "go" });
    feed.update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      },
      false,
    );
    feed.update(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit a.ts",
        kind: "edit",
        status: "in_progress",
        content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }],
      },
      false,
    );
    feed.update(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
      },
      false,
    );
    feed.update({ sessionUpdate: "usage_update", used: 10, size: 100 }, false);
    feed.endTurn({ stopReason: "end_turn" }, { used: 10, size: 100 });
    const all = items(rowId);
    expect(JSON.stringify(all)).not.toContain("aGVsbG8=");
    const assistant = all.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({
      parts: [{ type: "image", mimeType: "image/png", bytes: 5 }],
    });
    const tool = all.filter((i) => i.kind === "tool");
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({
      status: "completed",
      content: [{ type: "diff", path: "a.ts" }],
    });
    expect(domain.store.snapshot(rowId, 5)?.head).toMatchObject({
      usage: { used: 10, size: 100 },
    });
  });

  it("时间线已有内容时回放不写条目，只报恢复进度；为空时回放写成 replay 回合", async () => {
    await boot();
    const filled = feedOf("row-filled");
    filled.feed.beginTurn("1-1", { text: "old" });
    filled.feed.endTurn({ stopReason: "end_turn" });
    const before = items("row-filled").length;
    const second = feedOf("row-filled");
    expect(second.feed.hadHistory).toBe(true);
    second.feed.restoring();
    second.feed.update(
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "old" },
      },
      true,
    );
    expect(items("row-filled")).toHaveLength(before);
    expect(domain.activityOf("row-filled")?.phase).toBe("restoring");
    second.feed.ready();
    expect(domain.activityOf("row-filled")?.phase).toBe("idle");

    const empty = feedOf("row-empty");
    expect(empty.feed.hadHistory).toBe(false);
    const replay = (kind: string, text: string) =>
      empty.feed.update(
        { sessionUpdate: kind, content: { type: "text", text } },
        true,
      );
    replay("user_message_chunk", "q1");
    replay("agent_message_chunk", "a1");
    replay("user_message_chunk", "q2");
    replay("agent_message_chunk", "a2");
    empty.feed.ready();
    const all = items("row-empty");
    expect(all.filter((i) => i.kind === "turn")).toHaveLength(2);
    expect(all.every((i) => i.source === "replay")).toBe(true);
    expect(all.filter((i) => i.kind === "assistant")).toHaveLength(2);
  });

  it("一个回合 1000 个分块只刷写个位数次", async () => {
    await boot();
    const { feed, rowId } = feedOf("row-flush");
    feed.beginTurn("1-1", { text: "go" });
    const before = domain.writer.flushes;
    for (let i = 0; i < 1000; i += 1) {
      feed.update(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `c${i} ` },
        },
        false,
      );
    }
    feed.endTurn({ stopReason: "end_turn" });
    expect(domain.writer.flushes - before).toBeLessThanOrEqual(4);
    const assistant = items(rowId).find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ streaming: false });
  });
});

describe("驱动切换与休眠", () => {
  const unix = process.platform !== "win32";
  (unix ? it : it.skip)(
    "切到终端再切回：同一条时间线延续，写 driver_switched，接回不重复历史",
    async () => {
      await boot();
      const { nodeId, rowId } = await start("remember me");
      await until(turnsEnded, (turns) => turns.length > 0);
      const before = items(rowId).filter((i) => i.kind === "user");
      expect(before).toHaveLength(1);

      for (const driver of ["terminal", "acp"] as const) {
        const switched = await open!.core.call(
          "POST",
          `/api/acp/nodes/${nodeId}/driver`,
          { driver },
        );
        expect(switched.status, JSON.stringify(switched.body)).toBe(200);
      }
      await until(
        () => domain.activityOf(rowId)?.phase,
        (phase) => phase === "idle",
      );
      const all = items(rowId);
      expect(
        all.filter((i) => i.kind === "notice" && i.code === "driver_switched"),
      ).toHaveLength(2);
      // 时间线非空：接回不回放，用户消息仍然只有一条。
      expect(all.filter((i) => i.kind === "user")).toHaveLength(1);
      expect(all.some((i) => i.kind === "notice" && i.code === "resumed")).toBe(
        true,
      );
      expect(activities(rowId).map((a) => a.phase)).toContain("switching");
    },
  );

  it("休眠与唤醒事件写进时间线，活动 sleeping", async () => {
    await boot();
    const { nodeId, rowId } = await start("hi");
    await until(turnsEnded, (turns) => turns.length > 0);
    open!.core.bus.emit("workspace.event", {
      workspaceId: open!.workspaceId,
      event: {
        type: "terminal.hibernation",
        sessionId: rowId,
        nodeId,
        state: "hibernated",
      },
    });
    expect(domain.activityOf(rowId)?.phase).toBe("sleeping");
    open!.core.bus.emit("workspace.event", {
      workspaceId: open!.workspaceId,
      event: {
        type: "terminal.hibernation",
        sessionId: rowId,
        nodeId,
        state: "running",
      },
    });
    const codes = items(rowId).flatMap((i) =>
      i.kind === "notice" ? [i.code] : [],
    );
    expect(codes).toEqual(expect.arrayContaining(["hibernated", "woke"]));
  });
});
