import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import {
  type IntakeCandidate,
  getCandidate,
  insertCandidate,
  saveSource,
  threadVersion,
} from "../workflow/intake";
import {
  intakeEventId,
  intakeSummary,
  publishIntake,
  recordIntakeEvent,
} from "./intake-fanout";
import { composeCard, openEvents } from "./router-events";
import { pendingFor } from "./send-queue";
import { nowSeconds } from "./service";

/** 候选到协调者（契约 §104.4）：事件 id 与候选相同、概要一行、卡片多一句、不投成员。 */

const REPO = "github.com/acme/app";
let fixture: AgentFixture;
let lead: string;

beforeEach(() => {
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
});

afterEach(() => fixture.close());

function candidate(title = "登录页\n按钮错位 SECRET-BODY"): IntakeCandidate {
  const source = saveSource(
    fixture.database,
    {
      coordinatorNodeId: lead,
      workspaceId: fixture.workspaceId,
      repo: REPO,
      kinds: ["issue"],
      mode: "observe",
      allow: ["alice"],
      enabled: true,
    },
    { present: false, remote: false, hash: "", text: "", truncated: false },
    1_000,
  );
  const { id } = insertCandidate(
    fixture.database,
    {
      source,
      kind: "issue",
      number: 12,
      version: threadVersion(2_000),
      title,
      author: "alice",
      url: "https://github.com/acme/app/issues/12",
      request: { by: "alice", via: "thread", at: 2_000 },
      sourceAt: 2_000,
    },
    3_000,
  );
  return getCandidate(fixture.database, id) as IntakeCandidate;
}

describe("intake fanout", () => {
  it("writes one intake event per candidate with the candidate id and a one-line summary", () => {
    const row = candidate();
    expect(recordIntakeEvent(fixture.collab, row, "observe")).toBe(true);
    expect(recordIntakeEvent(fixture.collab, row, "observe")).toBe(false);
    const events = openEvents(fixture.database, lead, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: row.id,
      kind: "intake",
      itemId: null,
      sourceNodeId: null,
      summary: `候选 issue ${REPO}#12「登录页 按钮错位 SECRET-BODY」 · alice · observe · 已授权`,
    });
    expect(events[0]?.summary).not.toContain("\n");
    expect(fixture.nudged).toContain(lead);
    // 不投任何成员。
    expect(
      pendingFor(fixture.database, lead, nowSeconds(fixture.collab)),
    ).toHaveLength(0);
  });

  it("caps the title at 60 characters and marks unauthorized requests", () => {
    const summary = intakeSummary(
      {
        kind: "pull",
        repo: REPO,
        number: 3,
        title: "字".repeat(80),
        author: null,
        authorized: false,
      },
      "auto",
    );
    expect(summary).toContain(`「${"字".repeat(59)}…」`);
    expect(summary.endsWith("(未知作者) · auto · 未授权")).toBe(true);
  });

  it("adds the intake usage line to the card only when an intake row is present", () => {
    const row = candidate();
    recordIntakeEvent(fixture.collab, row, "observe");
    const events = openEvents(fixture.database, lead, 10);
    const card = composeCard(events, events.length);
    expect(card).toContain("canvas intake --candidate <id>");
    expect(card).toContain("判定即确认，不用 ack");
    expect(composeCard([], 0)).not.toContain("canvas intake");
  });

  it("keeps event ids within the table limit", () => {
    expect(intakeEventId("x".repeat(300))).toHaveLength(200);
  });

  it("publishes a workflow.intake frame without title or body", () => {
    const row = candidate();
    const frames: { workspaceId: string; event: unknown }[] = [];
    publishIntake(
      fixture.database,
      (workspaceId, event) => {
        frames.push({ workspaceId, event });
      },
      row,
    );
    expect(frames).toEqual([
      {
        workspaceId: fixture.workspaceId,
        event: {
          type: "workflow.intake",
          boardId: fixture.boardId,
          coordinatorNodeId: lead,
          candidateId: row.id,
          sourceId: row.sourceId,
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("SECRET-BODY");
  });
});
