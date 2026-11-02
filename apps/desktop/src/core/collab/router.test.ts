import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { freeLease } from "../drive/lease";
import { recordReport } from "../workflow/work-items";
import { ProgressWatchdog } from "../workflow/progress-watchdog";
import { setStallSource } from "../agent/stalled";
import { TaskWatch } from "../workflow/task-watch";
import { resetWaitTrackers } from "./control/wait";
import { type ControlOutcome, controlDispatcher } from "./control";
import { backoffSeconds } from "./router-cards";
import { followupFromComment, followupsFromPrompt } from "./router-followup";
import {
  MAX_CARD_ROWS,
  cardEvents,
  countOpen,
  insertEvent,
  openEvents,
  recordRouterEvent,
} from "./router-events";
import { recordStalled, recordTaskDone } from "./router-sources";
import { resetSendLimits } from "./send-limits";
import { pendingFor } from "./send-queue";
import { putContextLinks } from "../canvas/context-links";
import { SendPump } from "./send-pump";
import { resetInboxWake } from "./wake";

/**
 * 协调者的统一事件队列（契约 §93，#696）：事件幂等、忙时合并成一张卡片、投递
 * 失败按退避重试且不过期、确认后不再出现、跟进绕过协调者直达成员、交回回到
 * 卡片、看门狗与报告只写事件表、卡片不带终端原文。
 */

let fixture: AgentFixture;
let lead: string;
let pump: SendPump;
let clock: number;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function result(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body.result as Record<string, unknown>;
}

function refusal(outcome: ControlOutcome): { status: number; code: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

async function dispatch(taskId: string, name = taskId): Promise<string> {
  const id = result(
    await run(lead, "open-agent", {
      agent: "codex",
      task: `do ${taskId}`,
      "task-id": taskId,
      name,
    }),
  ).id as string;
  fixture.session(id, "codex");
  // 首条任务不在本组用例的范围里。
  fixture.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
    )
    .run(id);
  return id;
}

function leadState(state: string): void {
  fixture.terminal.drive.set(lead, {
    nodeId: lead,
    sessionId: leadSession,
    state,
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
  } as never);
}

let leadSession: string;

/** 投给协调者自己的卡片。 */
function cardsDelivered(): string[] {
  return fixture.terminal.submits
    .filter((submit) => submit.sessionId === leadSession)
    .map((submit) => submit.data);
}

function context() {
  return { ...fixture.collab, now: () => new Date(clock) };
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  clock = Date.now();
  lead = fixture.agentNode("lead", "ama");
  leadSession = fixture.session(lead, "ama");
  fixture.terminal.foreground = { command: "ama" };
  leadState("idle");
  pump = new SendPump(() => context());
});

afterEach(() => {
  pump.stop();
  setStallSource(undefined);
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("the event table", () => {
  it("writes an event once per id", async () => {
    const member = await dispatch("s1:t1");
    const event = {
      id: "report:s1:t1:abc",
      coordinatorNodeId: lead,
      kind: "report" as const,
      itemId: "s1:t1",
      sourceNodeId: member,
      summary: "ready：done",
    };
    expect(recordRouterEvent(fixture.collab, event)).toBe(true);
    expect(recordRouterEvent(fixture.collab, event)).toBe(false);
    expect(openEvents(fixture.database, lead, 50)).toHaveLength(1);
    // 新的写入叫醒出队泵；重复的不叫。
    expect(fixture.nudged.filter((id) => id === lead)).toHaveLength(1);
  });

  it("makes the same report id from the same stall, and a new one for a new fingerprint", async () => {
    const member = await dispatch("s1:t1");
    const stall = {
      coordinatorNodeId: lead,
      memberNodeId: member,
      taskId: "s1:t1",
      reason: "stalled" as const,
      minutes: 11,
      basis: "working|2026-11-02T00:00:00Z",
    };
    expect(recordStalled(fixture.collab, stall)).toBe(true);
    expect(recordStalled(fixture.collab, stall)).toBe(false);
    expect(
      recordStalled(fixture.collab, { ...stall, basis: "working|later" }),
    ).toBe(true);
    expect(countOpen(fixture.database, lead)).toBe(2);
  });

  it("is deleted with the coordinator node", () => {
    recordRouterEvent(fixture.collab, {
      id: "inbox:gone",
      coordinatorNodeId: lead,
      kind: "inbox",
      summary: "x",
    });
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(lead);
    expect(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS total FROM router_events")
          .get() as { total: number }
      ).total,
    ).toBe(0);
  });

  it("drops an event whose coordinator node is gone", () => {
    expect(
      recordRouterEvent(fixture.collab, {
        id: "x",
        coordinatorNodeId: "nope",
        kind: "inbox",
        summary: "x",
      }),
    ).toBe(false);
  });
});

describe("the batched card", () => {
  it("merges events that arrive while the coordinator is busy into one card", async () => {
    const a = await dispatch("s1:a", "alpha");
    const b = await dispatch("s1:b", "beta");
    leadState("busy");
    result(await run(a, "report", { state: "ready", summary: "a done" }));
    result(await run(b, "report", { state: "ready", summary: "b done" }));
    await pump.drain(lead);
    expect(cardsDelivered()).toHaveLength(0);
    expect(countOpen(fixture.database, lead)).toBe(2);

    leadState("idle");
    await pump.drain(lead);
    const cards = cardsDelivered();
    expect(cards).toHaveLength(1);
    const card = cards[0] ?? "";
    expect(card).toContain("a done");
    expect(card).toContain("b done");
    expect(card).toContain("canvas items --item");
    expect(card).toContain("canvas ack --event");
    // 署名是应用，不是任何成员。
    expect(card).toContain("Armadra 收件箱");
    // 同一批事件不会再投第二张：它们提醒过了。
    await pump.drain(lead);
    expect(cardsDelivered()).toHaveLength(1);
    // 没确认的仍在表里。
    expect(countOpen(fixture.database, lead)).toBe(2);
  });

  it("lists at most twenty rows and the rest follow on the next card", async () => {
    for (let index = 0; index < MAX_CARD_ROWS + 3; index += 1) {
      recordRouterEvent(fixture.collab, {
        id: `inbox:m${index}`,
        coordinatorNodeId: lead,
        kind: "inbox",
        summary: `note ${index}`,
      });
    }
    expect(cardEvents(fixture.database, lead)).toHaveLength(MAX_CARD_ROWS);
    await pump.drain(lead);
    const first = cardsDelivered()[0] ?? "";
    expect(first.match(/ · inbox · /g)).toHaveLength(MAX_CARD_ROWS);
    expect(first).toContain("还有 3 条没列出");
    // 没列出的三条还没提醒过：下一次空闲再投，且排在前面。
    await pump.drain(lead);
    expect(cardsDelivered()).toHaveLength(2);
    expect(cardsDelivered()[1]).toContain("note 22");
  });

  it("does not deliver when nothing is new, and waits behind queued deliveries", async () => {
    await pump.drain(lead);
    expect(cardsDelivered()).toHaveLength(0);
    recordRouterEvent(fixture.collab, {
      id: "inbox:q",
      coordinatorNodeId: lead,
      kind: "inbox",
      summary: "later",
    });
    // 队里已经排着一条别的：卡片不抢同一个空闲窗口。
    fixture.database
      .prepare(
        "INSERT INTO agent_send_queue (id, workspace_id, source_node_id, target_node_id, origin, body, hops, trail, created_at, expires_at, attempts, state, source_kind) " +
          "VALUES ('q1', ?, ?, ?, 'send', 'x', 0, '[]', ?, ?, 0, 'delivering', 'node')",
      )
      .run(
        fixture.workspaceId,
        lead,
        lead,
        Math.floor(clock / 1000),
        Math.floor(clock / 1000) + 300,
      );
    expect(await pump.cards.deliver(context(), lead)).toBe("busy");
    expect(cardsDelivered()).toHaveLength(0);
  });

  it("carries no terminal text: only node names, item ids, kinds and the member's own line", async () => {
    const member = await dispatch("s1:t1", "worker");
    fixture.terminal.capture = "TERMINAL-SECRET";
    result(
      await run(member, "report", { state: "failed", summary: "build broke" }),
    );
    recordStalled(fixture.collab, {
      coordinatorNodeId: lead,
      memberNodeId: member,
      taskId: "s1:t1",
      reason: "stalled",
      minutes: 12,
      basis: "working|1",
    });
    await pump.drain(lead);
    const card = cardsDelivered()[0] ?? "";
    expect(card).toContain("「worker」");
    expect(card).toContain("s1:t1");
    expect(card).toContain("build broke");
    expect(card).not.toContain("TERMINAL-SECRET");
  });
});

describe("durable delivery", () => {
  it("retries with a 5 s to 300 s backoff and never gives the events up", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffSeconds)).toEqual([
      5, 10, 20, 40, 80, 160, 300, 300,
    ]);
    recordRouterEvent(fixture.collab, {
      id: "inbox:r1",
      coordinatorNodeId: lead,
      kind: "inbox",
      summary: "will retry",
    });
    // 门链拒绝（会话没了）：失败、退避。写到一半失败是 unknown，另有用例。
    fixture.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'exited' WHERE owner_node_id = ?",
      )
      .run(lead);
    expect(await pump.cards.deliver(context(), lead)).toBe("failed");
    // 退避中：不再试。
    expect(await pump.cards.deliver(context(), lead)).toBe("waiting");
    expect(cardsDelivered()).toHaveLength(0);

    // 再失败几轮，间隔翻倍直到封顶；过了多久，事件都在，也没有留下排队项。
    let waited = 5_000;
    for (let round = 0; round < 6; round += 1) {
      clock += waited;
      expect(await pump.cards.deliver(context(), lead)).toBe("failed");
      waited = Math.min(300_000, waited * 2);
    }
    clock += 24 * 3_600_000;
    expect(openEvents(fixture.database, lead, 50)).toHaveLength(1);
    expect(
      pendingFor(fixture.database, lead, Math.floor(clock / 1000)),
    ).toHaveLength(0);

    // 终端好了：一天之后照样投出去，投完不再退避。
    fixture.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'running' WHERE owner_node_id = ?",
      )
      .run(lead);
    expect(await pump.cards.deliver(context(), lead)).toBe("delivered");
    expect(cardsDelivered()).toHaveLength(1);
    expect(cardsDelivered()[0]).toContain("will retry");
    expect(pump.cards.waiting()).toBe(0);
  });

  it("tries a coordinator that only reported its opening, and a finished turn clears the backoff", async () => {
    recordRouterEvent(fixture.collab, {
      id: "inbox:s1",
      coordinatorNodeId: lead,
      kind: "inbox",
      summary: "while starting",
    });
    leadState("starting");
    // 门链说还不行（没有状态上报）：失败、退避，事件还在。
    expect(await pump.cards.deliver(context(), lead)).toBe("failed");
    expect(await pump.cards.deliver(context(), lead)).toBe("waiting");
    leadState("idle");
    expect(await pump.cards.deliver(context(), lead)).toBe("waiting");
    // 协调者报了一条结束的状态：退避清零，马上投出去。
    pump.noteStatus(lead, "done");
    await new Promise((done) => setTimeout(done, 100));
    expect(cardsDelivered()).toHaveLength(1);
    expect(cardsDelivered()[0]).toContain("while starting");
  });

  it("treats a half-written card (unknown outcome) as delivered and never pastes it twice", async () => {
    recordRouterEvent(fixture.collab, {
      id: "inbox:u1",
      coordinatorNodeId: lead,
      kind: "inbox",
      summary: "maybe twice",
    });
    fixture.terminal.submitError = new Error("pty went away mid-write");
    expect(await pump.cards.deliver(context(), lead)).toBe("delivered");
    fixture.terminal.submitError = undefined;
    // 提醒过了，不退避、不重发。
    expect(pump.cards.waiting()).toBe(0);
    expect(await pump.cards.deliver(context(), lead)).toBe("none");
    expect(cardsDelivered()).toHaveLength(0);
    expect(
      cardEvents(fixture.database, lead).map((event) => event.cardedAt),
    ).not.toContain(null);
  });

  it("is retried by the sweep after a restart (backoff state is in memory)", async () => {
    recordRouterEvent(fixture.collab, {
      id: "inbox:r2",
      coordinatorNodeId: lead,
      kind: "inbox",
      summary: "after restart",
    });
    expect(pump.cards.due(context())).toEqual([lead]);
    const fresh = new SendPump(() => context());
    await fresh.drain(lead);
    expect(cardsDelivered()).toHaveLength(1);
    fresh.stop();
  });
});

describe("events and ack", () => {
  it("reads unacknowledged events and acknowledging removes them from later cards", async () => {
    const a = await dispatch("s1:a", "alpha");
    const b = await dispatch("s1:b", "beta");
    result(await run(a, "report", { state: "ready", summary: "a done" }));
    result(await run(b, "report", { state: "blocked", summary: "b stuck" }));
    await pump.drain(lead);

    const listed = result(await run(lead, "events", {}));
    const events = listed.events as {
      id: string;
      item: string;
      kind: string;
    }[];
    expect(events).toHaveLength(2);
    expect(listed.total).toBe(2);
    expect(events.map((event) => event.item)).toEqual(["s1:a", "s1:b"]);

    const acked = result(await run(lead, "ack", { event: events[0]?.id }));
    expect(acked).toMatchObject({ acked: true });
    // 再确认一次是无事发生；确认不存在的 404；别人的事件同答 404。
    expect(
      result(await run(lead, "ack", { event: events[0]?.id })),
    ).toMatchObject({
      acked: false,
    });
    expect(refusal(await run(lead, "ack", { event: "nope" }))).toMatchObject({
      status: 404,
      code: "event_not_found",
    });
    expect(
      refusal(await run(a, "ack", { event: events[1]?.id })),
    ).toMatchObject({
      status: 404,
    });
    expect(
      refusal(await run(lead, "ack", { event: events[1]?.id, id: "m" })),
    ).toMatchObject({
      status: 400,
    });
    expect(
      (result(await run(lead, "events", {})).events as unknown[]).length,
    ).toBe(1);

    // 下一张卡片里没有已确认的那条。
    result(
      await run(a, "report", { state: "failed", summary: "a broke later" }),
    );
    await pump.drain(lead);
    const second = cardsDelivered()[1] ?? "";
    expect(second).not.toContain("a done");
    expect(second).toContain("b stuck");
    expect(second).toContain("a broke later");
  });

  it("honours --limit and says what is left", async () => {
    for (let index = 0; index < 5; index += 1) {
      recordRouterEvent(fixture.collab, {
        id: `inbox:l${index}`,
        coordinatorNodeId: lead,
        kind: "inbox",
        summary: `n${index}`,
      });
    }
    const listed = await run(lead, "events", { limit: 2 });
    if (!listed.ok) throw new Error("refused");
    expect((listed.body.result as { events: unknown[] }).events).toHaveLength(
      2,
    );
    expect(String(listed.body.message)).toContain("共 5 条未确认");
  });

  it("still acknowledges mailbox messages with --id, and a bare --event is refused", async () => {
    const peer = fixture.agentNode("peer", "codex");
    fixture.link(lead, peer);
    const posted = await run(peer, "post", {
      to: lead,
      key: "k1",
      body: "hello",
    });
    if (!posted.ok) throw new Error("refused");
    const id = posted.body.id as string;
    expect((await run(lead, "ack", { id })).ok).toBe(true);
    expect(refusal(await run(lead, "ack", { event: true }))).toMatchObject({
      status: 400,
    });
  });
});

describe("handback", () => {
  it("comes back to the coordinator's card", async () => {
    const member = await dispatch("s1:t1", "worker");
    result(
      await run(member, "handback", { item: "s1:t1", reason: "not mine" }),
    );
    await pump.drain(lead);
    const card = cardsDelivered()[0] ?? "";
    expect(card).toContain("handback:s1:t1");
    expect(card).toContain(" · handback · ");
    expect(card).toContain("交回：not mine");
  });
});

describe("one path only", () => {
  it("writes reports and stalls to the event table and nothing to the mailbox or the send queue", async () => {
    const member = await dispatch("s1:t1");
    result(await run(member, "report", { state: "ready", summary: "done" }));
    const clockNow = clock;
    const dog = new ProgressWatchdog({
      database: fixture.database,
      publish: () => fixture.collab.publish,
      thresholds: () => ({ stalledMs: 600_000, needsHumanMs: 900_000 }),
      lastOutputAt: () => undefined,
      running: () => true,
      wake: (wake) => recordStalled(fixture.collab, wake),
      clock: () => clockNow,
    });
    setStallSource(dog);
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, last_event_at) " +
          "VALUES (?, ?, 'codex', 'working', 0, 1, 0, ?, ?)",
      )
      .run(
        member,
        fixture.workspaceId,
        new Date(clockNow - 700_000).toISOString(),
        new Date(clockNow - 700_000).toISOString(),
      );
    dog.scan();
    const kinds = openEvents(fixture.database, lead, 50).map((e) => e.kind);
    expect(kinds).toEqual(["report", "stalled"]);
    const mailbox = fixture.database
      .prepare(
        "SELECT COUNT(*) AS total FROM agent_mailbox WHERE target_node_id = ?",
      )
      .get(lead) as { total: number };
    expect(mailbox.total).toBe(0);
    expect(
      pendingFor(fixture.database, lead, 0).filter(
        (i) => i.origin === "mailbox-wake",
      ),
    ).toHaveLength(0);
  });

  it("records a task-done event when the watcher settles a task nobody waits on", async () => {
    const member = await dispatch("s1:t1");
    fixture.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
          "VALUES ('m1', ?, ?, ?, 'task:s1:t1:result', 'finished', ?, ?)",
      )
      .run(
        fixture.workspaceId,
        member,
        lead,
        Math.floor(clock / 1000),
        Math.floor(clock / 1000) + 3600,
      );
    const watch = new TaskWatch({
      database: fixture.database,
      publish: () => fixture.collab.publish,
      everyMs: false,
      onSettled: (run, status) => recordTaskDone(fixture.collab, run, status),
    });
    expect(watch.sweep()).toBe(1);
    const events = openEvents(fixture.database, lead, 50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "task-done",
      id: "task-done:s1:t1:done",
      itemId: "s1:t1",
    });
    expect(events[0]?.summary).not.toContain("finished");
    // 同一个结束再落一次不会多一行。
    expect(
      recordTaskDone(
        fixture.collab,
        { taskId: "s1:t1", coordinatorNodeId: lead, nodeId: member } as never,
        "done",
      ),
    ).toBe(false);
  });

  it("turns a post to the coordinator into an inbox event that acknowledging the message clears", async () => {
    await dispatch("s1:t1");
    const peer = fixture.agentNode("peer", "codex");
    fixture.link(lead, peer);
    const posted = await run(peer, "post", {
      to: lead,
      key: "note1",
      body: "FYI the lint rule changed\nsecond line",
    });
    if (!posted.ok) throw new Error("refused");
    const events = openEvents(fixture.database, lead, 50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "inbox",
      id: `inbox:${posted.body.id}`,
    });
    expect(events[0]?.summary).toContain("FYI the lint rule changed");
    expect(events[0]?.summary).not.toContain("second line");
    // 成员的任务结果有自己的路，不算普通留言。
    await run(peer, "post", {
      to: lead,
      key: "task:s1:t1:result",
      body: "result",
    });
    expect(openEvents(fixture.database, lead, 50)).toHaveLength(1);
    // 确认那条消息，事件一并确认。
    result(
      await run(lead, "ack", { id: posted.body.id }).then(
        (o) => ({ ...o, body: { result: {} } }) as never,
      ),
    );
    expect(openEvents(fixture.database, lead, 50)).toHaveLength(0);
  });
});

describe("follow-up ownership", () => {
  it("hands a person's words that name an item straight to the member and tells the coordinator only 'forwarded'", async () => {
    const member = await dispatch("s1:t1", "painter");
    const forwarded = followupsFromPrompt(
      context(),
      lead,
      "#s1:t1 那个改一下颜色，改成蓝色。",
    );
    expect(forwarded).toBe(1);
    // 原话进了成员的投递队列，不在协调者的。
    const toMember = pendingFor(
      fixture.database,
      member,
      Math.floor(clock / 1000),
    );
    expect(toMember.some((item) => item.body.includes("改成蓝色"))).toBe(true);
    expect(
      toMember.find((item) => item.body.includes("改成蓝色"))?.body,
    ).toContain("canvas handback --item s1:t1");
    expect(
      pendingFor(fixture.database, lead, Math.floor(clock / 1000)),
    ).toHaveLength(0);
    // 协调者只收到一行。
    const events = openEvents(fixture.database, lead, 50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "followup", itemId: "s1:t1" });
    // 入队不等于转到：此刻只能说排上了。
    expect(events[0]?.summary).toContain("「painter」");
    expect(events[0]?.summary).not.toContain("已转给");
    await pump.drain(lead);
    const card = cardsDelivered()[0] ?? "";
    expect(card).toContain("「painter」");
    expect(card).not.toContain("蓝色");
    expect(card).toContain("不要再派一份");
  });

  it("leaves a message that names nothing, names an unknown id, or is a delivered envelope to the coordinator", async () => {
    await dispatch("s1:t1");
    expect(followupsFromPrompt(context(), lead, "把登录页改一下")).toBe(0);
    expect(followupsFromPrompt(context(), lead, "见 #99 和 abc#s1:t1")).toBe(0);
    expect(
      followupsFromPrompt(
        context(),
        lead,
        "--- ARMADRA MESSAGE x ---\nfrom: a\n#s1:t1 something\n--- END ARMADRA MESSAGE x ---",
      ),
    ).toBe(0);
    expect(openEvents(fixture.database, lead, 50)).toHaveLength(0);
  });

  it("only recognises the coordinator's own items", async () => {
    await dispatch("s1:t1");
    const other = fixture.agentNode("other", "ama");
    expect(followupsFromPrompt(context(), other, "#s1:t1 do it")).toBe(0);
  });

  it("routes a comment on a member node to that member", async () => {
    const member = await dispatch("s1:t1", "painter");
    fixture.database
      .prepare(
        "INSERT INTO board_comments (id, board_id, anchor_kind, anchor_id, body, author_principal_id, created_at_ms, updated_at_ms) " +
          "VALUES ('c1', ?, 'node', ?, '颜色再深一点', 'owner', 1, 1)",
      )
      .run(fixture.boardId, member);
    expect(followupFromComment(context(), fixture.boardId, "c1", member)).toBe(
      true,
    );
    const toMember = pendingFor(
      fixture.database,
      member,
      Math.floor(clock / 1000),
    );
    expect(toMember.some((item) => item.body.includes("颜色再深一点"))).toBe(
      true,
    );
    expect(openEvents(fixture.database, lead, 50)[0]?.summary).toContain(
      "「painter」",
    );
    // 不是任何工作项成员的节点：什么也不做。
    const loner = fixture.agentNode("loner", "codex");
    expect(followupFromComment(context(), fixture.boardId, "c1", loner)).toBe(
      false,
    );
  });
});

describe("follow-up honesty and routing", () => {
  function comment(
    id: string,
    nodeId: string,
    body: string,
    parentId: string | null = null,
  ): void {
    fixture.database
      .prepare(
        "INSERT INTO board_comments (id, board_id, anchor_kind, anchor_id, body, author_principal_id, parent_id, created_at_ms, updated_at_ms) " +
          "VALUES (?, ?, 'node', ?, ?, 'owner', ?, 1, 1)",
      )
      .run(id, fixture.boardId, nodeId, body, parentId);
  }

  function failedEvents() {
    return openEvents(fixture.database, lead, 50).filter((event) =>
      event.summary.includes("没能转给"),
    );
  }

  it("tells the coordinator when the member link is removed before delivery", async () => {
    fixture.link(lead, await dispatch("s1:t1", "painter"));
    const member = fixture.database
      .prepare("SELECT target_node_id AS id FROM edges LIMIT 1")
      .get() as { id: string };
    expect(followupsFromPrompt(context(), lead, "#s1:t1 改成蓝色")).toBe(1);
    // 连线在排队期间被删掉：出队时门链以 NOT_LINKED 拒绝。
    putContextLinks(fixture.database, fixture.workspaceId, lead, []);
    putContextLinks(fixture.database, fixture.workspaceId, member.id, []);
    await pump.drain(member.id);
    await pump.drain(lead);
    const failed = failedEvents();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "followup", itemId: "s1:t1" });
    expect(failed[0]?.summary).toContain("「painter」");
    expect(cardsDelivered().join("\n")).toContain("没能转给「painter」");
    // 原话不进卡片。
    expect(cardsDelivered().join("\n")).not.toContain("蓝色");
  });

  it("tells the coordinator when the queued follow-up expires unseen", async () => {
    const member = await dispatch("s1:t1", "painter");
    expect(followupsFromPrompt(context(), lead, "#s1:t1 改成蓝色")).toBe(1);
    leadState("busy");
    clock += 301_000;
    pump.sweep();
    leadState("idle");
    await pump.drain(lead);
    expect(failedEvents()).toHaveLength(1);
    expect(
      pendingFor(fixture.database, member, Math.floor(clock / 1000)),
    ).toHaveLength(0);
    // 再扫几遍也只报一次。
    pump.sweep();
    pump.sweep();
    expect(failedEvents()).toHaveLength(1);
  });

  it("does not report a failure for a follow-up that was delivered", async () => {
    const member = await dispatch("s1:t1", "painter");
    followupsFromPrompt(context(), lead, "#s1:t1 改成蓝色");
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
      )
      .run(member);
    clock += 301_000;
    pump.sweep();
    expect(failedEvents()).toHaveLength(0);
  });

  it("ignores comments on a member whose item already finished", async () => {
    const member = await dispatch("s1:t1", "painter");
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'done' WHERE task_id = ?",
      )
      .run("s1:t1");
    comment("c1", member, "颜色再深一点");
    expect(followupFromComment(context(), fixture.boardId, "c1", member)).toBe(
      false,
    );
    expect(openEvents(fixture.database, lead, 50)).toHaveLength(0);
    expect(
      pendingFor(fixture.database, member, Math.floor(clock / 1000)),
    ).toHaveLength(0);
  });

  it("picks the running item over a newer finished one, and skips replies", async () => {
    const member = await dispatch("s1:old", "painter");
    await dispatch("s1:newer", "painter2");
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET node_id = ?, started_at = started_at + 100 WHERE task_id = 's1:newer'",
      )
      .run(member);
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'done' WHERE task_id = 's1:newer'",
      )
      .run();
    comment("c1", member, "top level");
    comment("c2", member, "a reply", "c1");
    expect(followupFromComment(context(), fixture.boardId, "c2", member)).toBe(
      false,
    );
    expect(followupFromComment(context(), fixture.boardId, "c1", member)).toBe(
      true,
    );
    expect(openEvents(fixture.database, lead, 50)[0]).toMatchObject({
      itemId: "s1:old",
    });
  });

  it("forwards each member only the part of the prompt that names its item", async () => {
    const alpha = await dispatch("s1:a", "alpha");
    const beta = await dispatch("s1:b", "beta");
    expect(
      followupsFromPrompt(
        context(),
        lead,
        "#s1:a 标题改成蓝色。\n#s1:b 把按钮删掉。",
      ),
    ).toBe(2);
    const now = Math.floor(clock / 1000);
    const toAlpha = pendingFor(fixture.database, alpha, now)
      .map((item) => item.body)
      .join("\n");
    const toBeta = pendingFor(fixture.database, beta, now)
      .map((item) => item.body)
      .join("\n");
    expect(toAlpha).toContain("标题改成蓝色");
    expect(toAlpha).not.toContain("按钮删掉");
    expect(toBeta).toContain("按钮删掉");
    expect(toBeta).not.toContain("标题改成蓝色");
  });

  it("keeps the whole prompt for a member when a line names several items", async () => {
    const alpha = await dispatch("s1:a", "alpha");
    await dispatch("s1:b", "beta");
    followupsFromPrompt(context(), lead, "#s1:a #s1:b 都改成蓝色");
    expect(
      pendingFor(fixture.database, alpha, Math.floor(clock / 1000))
        .map((item) => item.body)
        .join("\n"),
    ).toContain("都改成蓝色");
  });
});

describe("event retention", () => {
  it("caps unacknowledged events per coordinator and trims very old ones", () => {
    const nowMs = clock;
    for (let index = 0; index < 560; index += 1) {
      insertEvent(
        fixture.database,
        {
          id: `inbox:cap${index}`,
          coordinatorNodeId: lead,
          kind: "inbox",
          summary: `n${index}`,
        },
        nowMs - 1_000_000 + index,
      );
    }
    insertEvent(
      fixture.database,
      {
        id: "inbox:ancient",
        coordinatorNodeId: lead,
        kind: "inbox",
        summary: "ancient",
      },
      nowMs - 40 * 24 * 3_600_000,
    );
    pump.cards.due(context());
    const open = openEvents(fixture.database, lead, 1000);
    expect(open.length).toBeLessThanOrEqual(500);
    expect(open.some((event) => event.id === "inbox:ancient")).toBe(false);
    // 留下的是最新的。
    expect(open.some((event) => event.id === "inbox:cap559")).toBe(true);
    expect(open.some((event) => event.id === "inbox:cap0")).toBe(false);
  });
});
