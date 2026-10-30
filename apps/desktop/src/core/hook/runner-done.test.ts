import { afterEach, describe, expect, it } from "vitest";
import type { CoreEvents } from "../bus";
import { type HookFixture, hookFixture } from "./fixture";
import { readRunnerDone } from "./runner-done";

/**
 * `runner_done` on `/hook/ama` (contract §15.5): a verified ama report becomes
 * the core-internal `runner.done` bus event and nothing else.
 */

let open: HookFixture[] = [];

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

function amaFixture(): {
  it_: HookFixture;
  done: CoreEvents["runner.done"][];
} {
  const it_ = hookFixture();
  open.push(it_);
  it_.core.database
    .prepare("UPDATE nodes SET data_json = ? WHERE id = ?")
    .run(
      JSON.stringify({ kind: "terminal", cwd: ".", agent: { id: "ama" } }),
      it_.nodeId,
    );
  const done: CoreEvents["runner.done"][] = [];
  it_.core.bus.on("runner.done", (event) => done.push(event));
  return { it_, done };
}

const PAYLOAD = {
  hookEventName: "runner_done",
  provider: "ama",
  sessionId: "sess-1",
  taskId: "sess-1:t1",
  round: 1,
  status: "aborted",
  isError: true,
  endedAt: 1_000,
};

async function post(
  it_: HookFixture,
  agent: string,
  payload: unknown,
  verified = true,
): Promise<number> {
  const answer = await it_.postHook(
    agent,
    { nodeId: it_.nodeId, version: 1, payload },
    {
      "x-armadra-hook-token": it_.bearer,
      ...(verified
        ? { "x-armadra-node-token": it_.service.issueNodeToken(it_.nodeId) }
        : {}),
    },
  );
  return answer.status;
}

describe("runner_done", () => {
  it("emits runner.done for a verified ama report, and touches no state", async () => {
    const { it_, done } = amaFixture();
    expect(await post(it_, "ama", PAYLOAD)).toBe(204);
    expect(done).toEqual([
      {
        workspaceId: it_.workspaceId,
        nodeId: it_.nodeId,
        taskId: "sess-1:t1",
        round: 1,
        status: "aborted",
      },
    ]);
    expect(it_.status()).toBeUndefined();
    expect(it_.published).toEqual([]);
  });

  it("drops an unverified report, another CLI's, and a malformed one", async () => {
    const { it_, done } = amaFixture();
    expect(await post(it_, "ama", PAYLOAD, false)).toBe(204);
    expect(await post(it_, "ama", { ...PAYLOAD, taskId: "bad id" })).toBe(204);
    expect(await post(it_, "ama", { ...PAYLOAD, round: 0 })).toBe(204);
    expect(await post(it_, "ama", { ...PAYLOAD, status: "done" })).toBe(204);
    expect(done).toEqual([]);
    expect(it_.status()).toBeUndefined();

    // A Pi node reporting the name: not ama's adapter.
    const other = hookFixture();
    open.push(other);
    other.core.database
      .prepare("UPDATE nodes SET data_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ kind: "terminal", cwd: ".", agent: { id: "pi" } }),
        other.nodeId,
      );
    const seen: unknown[] = [];
    other.core.bus.on("runner.done", (event) => seen.push(event));
    expect(await post(other, "pi", PAYLOAD)).toBe(204);
    expect(seen).toEqual([]);
    expect(other.status()).toBeUndefined();
  });

  it("reads only well-formed payloads", () => {
    expect(readRunnerDone(PAYLOAD)).toEqual({
      taskId: "sess-1:t1",
      round: 1,
      status: "aborted",
    });
    expect(
      readRunnerDone({ ...PAYLOAD, hookEventName: "agent_end" }),
    ).toBeUndefined();
    expect(readRunnerDone({ ...PAYLOAD, round: 1.5 })).toBeUndefined();
    expect(readRunnerDone(null)).toBeUndefined();
  });
});
