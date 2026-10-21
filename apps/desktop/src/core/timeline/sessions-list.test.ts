import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBoard } from "../canvas/boards";
import { install as installCanvas } from "../canvas/routes";
import { listSessions } from "../terminal/install";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { TimelineDomain as Domain, type TimelineDomain, install } from ".";
import { msg, seedSession, toolCall, turnCtx } from "./testing";

/**
 * 会话列表每行的 `activity` 与 `timelineSeq`（契约 §82）：冷启动和重连从这里补，
 * 没有时间线的会话省略这两项。
 */

let core: Fixture;
let domain: TimelineDomain;
let workspaceId: string;

beforeAll(async () => {
  core = fixture([
    installWorkspaces,
    installCanvas,
    (context) => {
      domain = install(context) as TimelineDomain;
    },
  ]);
  workspaceId = (
    (await core.call("GET", "/api/workspaces")).body as { id: string }[]
  )[0]!.id;
  const board = createBoard(core.database, workspaceId, "B").id;
  seedSession(core.database, board, workspaceId, "with", "n-with");
  seedSession(core.database, board, workspaceId, "plain", "n-plain");
  seedSession(
    core.database,
    board,
    workspaceId,
    "asleep",
    "n-asleep",
    "exited",
  );
  core.database
    .prepare(
      "UPDATE terminal_sessions SET termination_intent = 'hibernate' WHERE id = 'asleep'",
    )
    .run();
  seedSession(core.database, board, workspaceId, "dead", "n-dead", "exited");
  for (const [id, node] of [
    ["with", "n-with"],
    ["asleep", "n-asleep"],
    ["dead", "n-dead"],
  ] as const) {
    domain.open({ timelineId: id, workspaceId, nodeId: node });
    domain.writer.turnBegin(id, turnCtx(1, 1000), { text: "q" });
    domain.writer.flush();
  }
});

afterAll(() => core.close());

const rows = (alive: (id: string) => boolean) =>
  new Map(
    listSessions(
      core.database,
      workspaceId,
      alive,
      () => undefined,
      (id) => domain.summaryOf(id, alive(id)),
    ).map((row) => [row.sessionId, row]),
  );

describe("sessions.list 的 activity 与 timelineSeq", () => {
  it("有时间线的行带活动和序号，没有的省略", () => {
    const list = rows((id) => id === "with" || id === "plain");
    expect(list.get("with")).toMatchObject({
      activity: { phase: "idle" },
      timelineSeq: domain.store.get("with")!.headSeq,
    });
    expect(list.get("with")!.timelineSeq).toBeGreaterThan(0);
    expect(list.get("plain")).not.toHaveProperty("activity");
    expect(list.get("plain")).not.toHaveProperty("timelineSeq");
  });

  it("状态机里有记录就用它：提示发出、工具在跑，列表上立刻看得到", () => {
    domain.activity.prompt("with", "t1");
    domain.writer.acpUpdate(
      "with",
      toolCall("c1", { title: "跑测试", kind: "execute" }),
      turnCtx(1, 1001),
    );
    domain.writer.acpUpdate("with", msg("x"), turnCtx(1, 1002));
    const row = rows((id) => id === "with").get("with")!;
    expect(row.activity).toMatchObject({
      phase: "tool",
      detail: { label: "跑测试", toolKind: "execute" },
    });
  });

  it("重启后没有记录：活着补 idle、休眠补 sleeping、已退出补 exited", () => {
    // 新的域对象 = 没有任何内存里的活动记录（core 重启之后）。
    const fresh = new Domain(core);
    const summary = (id: string, alive: boolean) => fresh.summaryOf(id, alive);
    expect(summary("with", true)?.activity.phase).toBe("idle");
    expect(summary("asleep", false)?.activity.phase).toBe("sleeping");
    expect(summary("dead", false)?.activity.phase).toBe("exited");
    fresh.close();
  });
});
