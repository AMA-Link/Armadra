import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { finishTask, recordTaskStart, taskRun } from "./task-runs";
import {
  MAX_THREADS,
  POLL_RETENTION_MS,
  bindPull,
  botRounds,
  pollableItems,
  recordThreadEvent,
  threadCursor,
  threadOutcome,
} from "./threads";

/** 绑定与事件账（契约 §103.1、§103.3）。 */

let fixture: AgentFixture;

const PULL = {
  repo: "github.com/acme/app",
  number: 7,
  own: true,
  url: "https://github.com/acme/app/pull/7",
};

function start(taskId = "t1", now = 1_000) {
  recordTaskStart(fixture.database, {
    taskId,
    coordinatorNodeId: "lead",
    runnerId: "codex",
    nodeId: "n1",
    now,
  });
}

beforeEach(() => {
  fixture = agentFixture();
});
afterEach(() => fixture.close());

describe("bindPull", () => {
  it("writes one thread with the bind time and reads it back", () => {
    start();
    expect(taskRun(fixture.database, "t1")!.threads).toEqual([]);
    const bound = bindPull(fixture.database, "t1", PULL, 5_000);
    expect(bound.kind).toBe("bound");
    expect(taskRun(fixture.database, "t1")!.threads).toEqual([
      { kind: "pull", ...PULL, boundAt: 5_000 },
    ]);
  });

  it("binds the same pull once; own only ever goes up", () => {
    start();
    bindPull(fixture.database, "t1", { ...PULL, own: false }, 5_000);
    expect(
      bindPull(fixture.database, "t1", { ...PULL, own: false }, 6_000).kind,
    ).toBe("unchanged");
    expect(bindPull(fixture.database, "t1", PULL, 7_000).kind).toBe("bound");
    expect(
      bindPull(fixture.database, "t1", { ...PULL, own: false }, 8_000).kind,
    ).toBe("unchanged");
    const threads = taskRun(fixture.database, "t1")!.threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ own: true, boundAt: 5_000 });
  });

  it("caps the number of threads", () => {
    start();
    for (let number = 1; number <= MAX_THREADS; number += 1) {
      bindPull(fixture.database, "t1", { ...PULL, number }, 1);
    }
    expect(
      bindPull(fixture.database, "t1", { ...PULL, number: 99 }, 1).kind,
    ).toBe("full");
  });

  it("ignores a damaged column instead of failing the read", () => {
    start();
    fixture.database
      .prepare("UPDATE workflow_task_runs SET threads = ? WHERE task_id = ?")
      .run(
        '[{"kind":"pull","repo":"x","number":"no"},"junk",{"kind":"pull","repo":"h/o/n","number":3}]',
        "t1",
      );
    expect(taskRun(fixture.database, "t1")!.threads).toEqual([
      {
        kind: "pull",
        repo: "h/o/n",
        number: 3,
        own: false,
        url: "",
        boundAt: 0,
      },
    ]);
  });
});

describe("thread events", () => {
  const thread = { repo: PULL.repo, number: PULL.number };

  it("records an event id once", () => {
    start();
    const event = {
      itemId: "t1",
      eventId: "pr-comment:github.com/acme/app#7:c1",
      thread,
      kind: "comment" as const,
      delivered: true,
      sourceAt: 100,
    };
    expect(recordThreadEvent(fixture.database, event, 1)).toBe(true);
    expect(recordThreadEvent(fixture.database, event, 2)).toBe(false);
  });

  it("starts the cursor at the bind time and follows the latest comment or review", () => {
    start();
    bindPull(fixture.database, "t1", PULL, 5_000);
    const bound = taskRun(fixture.database, "t1")!.threads[0]!;
    expect(threadCursor(fixture.database, "t1", bound)).toBe(5_000);
    recordThreadEvent(
      fixture.database,
      {
        itemId: "t1",
        eventId: "a",
        thread,
        kind: "comment",
        delivered: true,
        sourceAt: 9_000,
      },
      9_500,
    );
    // checks 与 state 不推游标。
    recordThreadEvent(
      fixture.database,
      {
        itemId: "t1",
        eventId: "b",
        thread,
        kind: "checks",
        delivered: true,
        sourceAt: 20_000,
      },
      20_000,
    );
    expect(threadCursor(fixture.database, "t1", bound)).toBe(9_000);
  });

  it("counts delivered bot rounds per bot", () => {
    start();
    for (const [id, actor, delivered] of [
      ["1", "ci[bot]", true],
      ["2", "ci[bot]", true],
      ["3", "ci[bot]", false],
      ["4", "other[bot]", true],
    ] as const) {
      recordThreadEvent(
        fixture.database,
        {
          itemId: "t1",
          eventId: id,
          thread,
          kind: "comment",
          actor,
          delivered,
          sourceAt: 1,
        },
        1,
      );
    }
    expect(botRounds(fixture.database, "t1", thread, "ci[bot]")).toBe(2);
    expect(botRounds(fixture.database, "t1", thread, "other[bot]")).toBe(1);
  });

  it("reads the last terminal state of a thread", () => {
    start();
    expect(threadOutcome(fixture.database, "t1", thread)).toBeNull();
    recordThreadEvent(
      fixture.database,
      {
        itemId: "t1",
        eventId: "pr-state:x#7:closed",
        thread,
        kind: "state",
        delivered: true,
        sourceAt: 10,
      },
      10,
    );
    expect(threadOutcome(fixture.database, "t1", thread)).toBe("closed");
    recordThreadEvent(
      fixture.database,
      {
        itemId: "t1",
        eventId: "pr-state:x#7:merged",
        thread,
        kind: "state",
        delivered: true,
        sourceAt: 20,
      },
      20,
    );
    expect(threadOutcome(fixture.database, "t1", thread)).toBe("merged");
  });

  it("drops the events with the item", () => {
    start();
    recordThreadEvent(
      fixture.database,
      {
        itemId: "t1",
        eventId: "a",
        thread,
        kind: "comment",
        delivered: true,
        sourceAt: 1,
      },
      1,
    );
    fixture.database.exec("PRAGMA foreign_keys = ON");
    fixture.database
      .prepare("DELETE FROM workflow_task_runs WHERE task_id = 't1'")
      .run();
    const left = fixture.database
      .prepare("SELECT COUNT(*) AS total FROM thread_events")
      .get() as { total: number };
    expect(Number(left.total)).toBe(0);
  });
});

describe("pollableItems", () => {
  it("lists running items with threads, and ended ones for 14 days", () => {
    start("live");
    bindPull(fixture.database, "live", PULL, 1);
    start("done-fresh");
    bindPull(fixture.database, "done-fresh", { ...PULL, number: 8 }, 1);
    finishTask(fixture.database, "done-fresh", "done", null, 1_000_000);
    start("done-old");
    bindPull(fixture.database, "done-old", { ...PULL, number: 9 }, 1);
    finishTask(fixture.database, "done-old", "done", null, 1_000);
    start("unbound");
    const now = 1_000_000 + POLL_RETENTION_MS - 1;
    // done-old 的结束时刻是 1_000，已经超过 14 天。
    expect(
      pollableItems(fixture.database, now)
        .map((run) => run.taskId)
        .sort(),
    ).toEqual(["done-fresh", "live"]);
    expect(
      pollableItems(fixture.database, 1_000_000 + POLL_RETENTION_MS + 1)
        .map((run) => run.taskId)
        .sort(),
    ).toEqual(["live"]);
  });
});
