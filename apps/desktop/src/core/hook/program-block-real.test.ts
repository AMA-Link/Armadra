import { afterEach, describe, expect, it } from "vitest";

import { programBlockStands } from "../agent/target-state";
import { getAgentStatus, markAgentStatusRead } from "../agent/status";
import { type HookFixture, hookFixture, minutesAgo } from "./fixture";
import { sweepOnce } from "./sweep";

/**
 * 撤回 `blocked` 的判据对着**真实的状态行**：读回执、同会话事件、清扫合成的结束，
 * 各自是怎么动 `agent_status` 的，都用真函数走一遍，不手写行。
 */

let open: HookFixture[] = [];

function fixture(): HookFixture {
  const made = hookFixture();
  open.push(made);
  return made;
}

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

const status = (one: HookFixture) =>
  getAgentStatus(one.core.database, one.nodeId);

/** 一条比任何真实上报都早的 blocked 记录。 */
const EARLY = "2000-01-01T00:00:00.000Z";
/** 一条比任何真实上报都晚的 blocked 记录。 */
const LATE = "2999-01-01T00:00:00.000Z";

describe("a real done against a blocked record", () => {
  it("withdraws it when the CLI's own done came later", async () => {
    const one = fixture();
    await one.report({ hook_event_name: "UserPromptSubmit" });
    await one.report({ hook_event_name: "Stop" });
    expect(status(one)?.state).toBe("done");
    expect(
      programBlockStands({ state: "blocked", updatedAt: EARLY }, status(one)),
    ).toBe(false);
    expect(
      programBlockStands({ state: "blocked", updatedAt: LATE }, status(one)),
    ).toBe(true);
  });

  it("reading the receipt moves updatedAt and does not withdraw", async () => {
    const one = fixture();
    await one.report({ hook_event_name: "UserPromptSubmit" });
    await one.report({ hook_event_name: "Stop" });
    const before = status(one);
    // blocked 比 done 晚一点：读回执之后 updatedAt 比它新，但 doneAt 没动。
    const blockedAt = new Date(
      Date.parse(before?.doneAt as string) + 1_000,
    ).toISOString();
    const receipt = markAgentStatusRead(one.core.database, one.nodeId);
    expect(receipt?.cleared).toBe(true);
    const after = status(one);
    expect(Date.parse(after?.updatedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(before?.updatedAt as string),
    );
    expect(after?.doneAt).toBe(before?.doneAt);
    expect(
      programBlockStands({ state: "blocked", updatedAt: blockedAt }, after),
    ).toBe(true);
  });

  it("a SessionStart of the same session moves lastEventAt, not doneAt", async () => {
    const one = fixture();
    await one.report({ hook_event_name: "UserPromptSubmit" });
    await one.report({ hook_event_name: "Stop" });
    const done = status(one)?.doneAt;
    const blockedAt = new Date(
      Date.parse(done as string) + 1_000,
    ).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await one.report({ hook_event_name: "SessionStart" });
    expect(status(one)?.doneAt).toBe(done);
    expect(
      programBlockStands(
        { state: "blocked", updatedAt: blockedAt },
        status(one),
      ),
    ).toBe(true);
  });

  it("a done the sweep closes out (stale) never withdraws", async () => {
    const one = fixture();
    await one.report({ hook_event_name: "UserPromptSubmit" });
    // 沉默够久：清扫把它合成为 done（ended_by = stale）。
    one.core.database
      .prepare("UPDATE agent_status SET last_event_at = ? WHERE node_id = ?")
      .run(minutesAgo(60), one.nodeId);
    expect(sweepOnce(one.context)).toBe(1);
    const closed = status(one);
    expect(closed).toMatchObject({ state: "done", endedBy: "stale" });
    expect(
      programBlockStands({ state: "blocked", updatedAt: EARLY }, closed),
    ).toBe(true);
  });
});
