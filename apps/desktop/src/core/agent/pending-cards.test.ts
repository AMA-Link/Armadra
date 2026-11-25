import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentStatus as hookStatus } from "../hook/store";
import { type AgentFixture, agentFixture } from "./fixture";
import {
  forgetPendingCard,
  notePendingCard,
  pendingCardOf,
} from "./pending-cards";
import { getAgentStatus } from "./status";

let fixture: AgentFixture;
let nodeId: string;

beforeEach(() => {
  fixture = agentFixture();
  nodeId = fixture.agentNode("Claude");
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, pending_id, unread, verified, restored, updated_at) " +
        "VALUES (?, ?, 'claude', 'blocked', 'p-1', 0, 1, 0, '2026-11-25T00:00:00Z')",
    )
    .run(nodeId, fixture.workspaceId);
});

afterEach(() => {
  forgetPendingCard("p-1");
  fixture.close();
});

describe("pendingCard on the status frame", () => {
  it("is added to the status of a node whose pending approval is a plan card, by both readers", () => {
    expect(getAgentStatus(fixture.database, nodeId)).not.toHaveProperty(
      "pendingCard",
    );
    notePendingCard("p-1", "plan");
    expect(getAgentStatus(fixture.database, nodeId)).toMatchObject({
      pendingId: "p-1",
      pendingCard: "plan",
    });
    expect(hookStatus(fixture.database, nodeId)).toMatchObject({
      pendingId: "p-1",
      pendingCard: "plan",
    });
  });

  it("goes away when the card settles; a different pendingId never picks it up", () => {
    notePendingCard("p-1", "plan");
    forgetPendingCard("p-1");
    expect(getAgentStatus(fixture.database, nodeId)).not.toHaveProperty(
      "pendingCard",
    );
    notePendingCard("p-other", "plan");
    expect(pendingCardOf("p-1")).toBeUndefined();
    expect(getAgentStatus(fixture.database, nodeId)).not.toHaveProperty(
      "pendingCard",
    );
    forgetPendingCard("p-other");
    expect(pendingCardOf(undefined)).toBeUndefined();
    expect(pendingCardOf(null)).toBeUndefined();
  });
});
