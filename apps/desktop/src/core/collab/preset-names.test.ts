import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { controlDispatcher, type ControlOutcome } from "./control";
import { resetSendLimits } from "./send-limits";
import { resetInboxWake } from "./wake";

/**
 * 控制动词建的终端 / Agent 节点没给标题时用预设名，并把它当名字（Armadra#969）：
 * 与页面菜单新建同一套词库、同一条「本画布第一个空位」规则。
 */

let fixture: AgentFixture;
let coordinator: string;

async function run(
  verb: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const outcome: ControlOutcome = await dispatcher.dispatch(
    verb,
    callerFor(fixture, coordinator),
    args,
  );
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.body.result as Record<string, unknown>;
}

function stored(id: string): { title: string; handle: string | null } {
  const row = fixture.database
    .prepare(
      "SELECT title, json_extract(data_json, '$.handle') AS handle FROM nodes WHERE id = ?",
    )
    .get(id) as { title: string; handle: string | null };
  return { title: row.title, handle: row.handle };
}

function handleRow(id: string): string | undefined {
  const row = fixture.database
    .prepare("SELECT handle FROM node_handles WHERE node_id = ?")
    .get(id) as { handle: string } | undefined;
  return row?.handle;
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  coordinator = fixture.agentNode("协调者");
  fixture.session(coordinator, "claude");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("预设名", () => {
  it("open-agent 不给标题：预设名当标题，也当名字", async () => {
    const first = (await run("open-agent", { agent: "codex" })).id as string;
    const second = (await run("open-agent", { agent: "claude" })).id as string;
    expect(stored(first)).toEqual({ title: "Atlas", handle: "atlas" });
    expect(stored(second)).toEqual({ title: "Birch", handle: "birch" });
    expect(handleRow(first)).toBe("atlas");
  });

  it("给了 --title / --name 就照用，不起名字", async () => {
    const id = (await run("open-agent", { agent: "codex", name: "审阅" }))
      .id as string;
    expect(stored(id)).toEqual({ title: "审阅", handle: null });
  });

  it("open-terminal 不给标题也用预设名", async () => {
    const id = (await run("open-terminal")).id as string;
    expect(stored(id)).toEqual({ title: "Atlas", handle: "atlas" });
  });

  it("team 里没写标题的成员各取一个，写了的照用", async () => {
    const members = (
      (await run("team", {
        member: ["codex", "claude|审阅|看", "codex||写"],
      })) as { members: { id: string }[] }
    ).members;
    expect(members.map((member) => stored(member.id))).toEqual([
      { title: "Atlas", handle: "atlas" },
      { title: "审阅", handle: null },
      { title: "Birch", handle: "birch" },
    ]);
  });
});
