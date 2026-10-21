import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture } from "../agent/fixture";
import { AGENT_STATES } from "@armadra/shared";

import * as statusModule from "../agent/status";
import { getAgentStatus, upsertAgentStatus } from "./store";

/**
 * 状态来源的词汇是封闭的：库里只收认识的值。`acp` 是 core 以 ACP 驱动的会话
 * （ACP 会话视图设计 §4.1），与 `hook` 一样是上报。
 */

let fixture: AgentFixture;

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => fixture.close());

function write(stateSource: string, state = "working") {
  return upsertAgentStatus(fixture.database, {
    nodeId: "node-acp",
    workspaceId: fixture.workspaceId,
    agentId: "opencode",
    state,
    stateSource,
    unread: false,
    sessionId: "ses-1",
    pendingId: undefined,
    verified: true,
    transcriptPath: undefined,
    sessionPhase: undefined,
    errored: undefined,
    interrupted: undefined,
    lastEventAt: new Date().toISOString(),
  });
}

describe("agent_status.state_source", () => {
  it("stores acp like any other known source", () => {
    write("acp");
    expect(getAgentStatus(fixture.database, "node-acp")?.stateSource).toBe(
      "acp",
    );
  });

  it("refuses a source nobody recognises", () => {
    expect(() => write("invented")).toThrow("Unknown agent state source");
  });
});

/**
 * S11：状态词汇只有一份（共享层 `AGENT_STATES`）。写入方与读取方曾各存一份，
 * 一边四个值、一边六个，读到的值写入方永远不会写。
 */
describe("agent_status.state vocabulary (S11)", () => {
  it("stores every value of the shared vocabulary", () => {
    for (const state of AGENT_STATES) {
      write("hook", state);
      expect(getAgentStatus(fixture.database, "node-acp")?.state).toBe(state);
    }
  });

  it("refuses a state outside the shared vocabulary", () => {
    expect(() => write("hook", "idle")).toThrow("Unknown agent state");
    expect(() => write("hook", "error")).toThrow("Unknown agent state");
  });

  it("keeps no second copy in the reader", () => {
    expect("AGENT_STATES" in statusModule).toBe(false);
  });
});
