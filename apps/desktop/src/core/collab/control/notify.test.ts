import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import { type ControlOutcome, controlDispatcher } from ".";
import { recordRouterEvent } from "../router-events";
import { latestReplies } from "../router-replies";
import { resetSendLimits } from "../send-limits";
import { resetInboxWake } from "../wake";
import { resetWaitTrackers } from "./wait";

/**
 * `canvas notify`（契约 §101.1）：三种用途的前置条件、进度被拒、同一目标只发
 * 一次、`answer` 消耗那条 `followup`、只有协调者能用。
 */

let fixture: AgentFixture;
let lead: string;
let member: string;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body.result as Record<string, unknown>;
}

function refused(outcome: ControlOutcome): { status: number; code: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return { status: outcome.status, code: outcome.code };
}

function notify(args: Record<string, unknown>, as = lead) {
  return run(as, "notify", { item: "s1:t1", ...args });
}

beforeEach(async () => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
  member = ok(
    await run(lead, "open-agent", {
      agent: "codex",
      task: "do it",
      "task-id": "s1:t1",
      name: "member",
    }),
  ).id as string;
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("notify result", () => {
  it("is refused until the item is in person/review", async () => {
    const outcome = await notify({ purpose: "result", text: "做好了" });
    expect(refused(outcome)).toEqual({
      status: 409,
      code: "notify_precondition",
    });
    expect((outcome as { message: string }).message).toContain("person/review");
  });

  it("goes through once the member reported ready, and only once", async () => {
    ok(await run(member, "report", { state: "ready", summary: "done" }));
    const first = ok(await notify({ purpose: "result", text: "请验收" }));
    expect(first).toMatchObject({ purpose: "result", stage: "person/review" });
    expect(
      refused(await notify({ purpose: "result", text: "请验收" })),
    ).toEqual({ status: 409, code: "already_notified" });
    // 阶段再变化（新的报告时刻）之后可以再发一次。
    await new Promise((resolve) => setTimeout(resolve, 5));
    ok(await run(member, "report", { state: "ready", summary: "again" }));
    expect(
      ok(await notify({ purpose: "result", text: "再次请验收" })).purpose,
    ).toBe("result");
  });
});

describe("notify attention", () => {
  it("needs an open question and carries it verbatim", async () => {
    expect(
      refused(await notify({ purpose: "attention", text: "要你决定" })).code,
    ).toBe("notify_precondition");
    ok(
      await run(member, "report", {
        state: "waiting",
        summary: "stuck",
        "human-action": "用哪个测试账号？",
      }),
    );
    expect(
      refused(await notify({ purpose: "attention", text: "要你决定" })),
    ).toEqual({ status: 409, code: "notify_precondition" });
    const sent = ok(
      await notify({
        purpose: "attention",
        text: "要你决定：用哪个测试账号？",
      }),
    );
    expect(sent.purpose).toBe("attention");
    expect(
      refused(
        await notify({
          purpose: "attention",
          text: "再说一遍：用哪个测试账号？",
        }),
      ).code,
    ).toBe("already_notified");
  });

  it("allows the text to grow to the question's own limit", async () => {
    const question = "问".repeat(250);
    ok(
      await run(member, "report", {
        state: "waiting",
        summary: "s",
        "human-action": question,
      }),
    );
    ok(await notify({ purpose: "attention", text: question }));
  });
});

describe("notify answer", () => {
  function followup(id: string, item = "s1:t1") {
    recordRouterEvent(fixture.collab, {
      id,
      coordinatorNodeId: lead,
      kind: "followup",
      itemId: item,
      sourceNodeId: null,
      summary: "追问",
    });
  }

  it("needs a followup event of that item and consumes it", async () => {
    expect(
      refused(await notify({ purpose: "answer", text: "在做" })).code,
    ).toBe("notify_precondition");
    expect(
      refused(
        await notify({
          purpose: "answer",
          text: "在做",
          followup: "followup:s1:t1:x",
        }),
      ).code,
    ).toBe("notify_precondition");
    followup("followup:s1:t1:x");
    ok(
      await notify({
        purpose: "answer",
        text: "在做",
        followup: "followup:s1:t1:x",
      }),
    );
    expect(
      refused(
        await notify({
          purpose: "answer",
          text: "在做",
          followup: "followup:s1:t1:x",
        }),
      ).code,
    ).toBe("already_notified");
  });

  it("refuses a followup that belongs to another item or a failed forward", async () => {
    followup("followup:other:1", "other");
    followup("followup-failed:q1");
    for (const id of ["followup:other:1", "followup-failed:q1"]) {
      expect(
        refused(await notify({ purpose: "answer", text: "x", followup: id }))
          .code,
      ).toBe("notify_precondition");
    }
  });
});

describe("the gate", () => {
  it("rejects progress with 409", async () => {
    expect(refused(await notify({ purpose: "progress", text: "30%" }))).toEqual(
      {
        status: 409,
        code: "notify_precondition",
      },
    );
  });

  it("is for the coordinator of the item only", async () => {
    ok(await run(member, "report", { state: "ready", summary: "done" }));
    expect(
      refused(await notify({ purpose: "result", text: "x" }, member)),
    ).toEqual({ status: 404, code: "item_not_found" });
    expect(
      refused(await notify({ purpose: "result", text: "x", item: "nope" }))
        .code,
    ).toBe("item_not_found");
  });

  it("validates the text", async () => {
    ok(await run(member, "report", { state: "ready", summary: "done" }));
    expect(refused(await notify({ purpose: "result", text: " " })).code).toBe(
      "bad_request",
    );
    expect(
      refused(await notify({ purpose: "result", text: "字".repeat(101) })).code,
    ).toBe("bad_request");
    expect(refused(await notify({ text: "x" })).code).toBe("bad_request");
    expect(refused(await notify({ purpose: "chat", text: "x" })).code).toBe(
      "bad_request",
    );
  });

  it("stores the reply for the page and publishes a frame without the text", async () => {
    const frames = fixture.events.map((entry) => entry.event);
    ok(await run(member, "report", { state: "ready", summary: "done" }));
    ok(await notify({ purpose: "result", text: "秘密正文\u0007请验收" }));
    const stored = latestReplies(fixture.database, lead).get("s1:t1");
    expect(stored).toMatchObject({ purpose: "result", text: "秘密正文请验收" });
    const reply = fixture.events
      .map((entry) => entry.event)
      .find((frame) => frame.type === "workflow.reply");
    expect(frames).toBeDefined();
    expect(reply).toMatchObject({
      purpose: "result",
      taskId: "s1:t1",
      nodeId: member,
    });
    expect(JSON.stringify(reply)).not.toContain("秘密正文");
  });
});
