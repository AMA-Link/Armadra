import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import type { ForgeService } from "../../forge/service";
import { forgeRepo, remoteSegments } from "../../forge/service";
import { taskRun } from "../../workflow/task-runs";
import { type ControlOutcome, controlDispatcher } from ".";
import { parsePullRef, pullBindDeps, pullUrl } from "./pr-bind";
import { resetSendLimits } from "../send-limits";
import { resetInboxWake } from "../wake";
import { resetWaitTrackers } from "./wait";

/**
 * `report --pr` 与 `items --bind-pr`（契约 §103.1）：引用的写法、按工作区远端认
 * 仓库、自己开的与只看的、绑定幂等、只有派发者能代绑。
 */

let fixture: AgentFixture;
let lead: string;
let member: string;
const original = pullBindDeps.current;

/** 只认 `resolve`：把远端地址认成 GitHub / GitLab 的仓库，其余认不出。 */
const stubForge = {
  resolve(remoteUrl: string) {
    const parts = remoteSegments(remoteUrl);
    if (parts === undefined) throw new Error("bad remote");
    const gitlab = parts.host.startsWith("gitlab");
    const repository = forgeRepo(
      parts.host,
      parts.segments.slice(0, -1).join("/"),
      parts.segments.at(-1) as string,
    );
    const known = parts.host.startsWith("github") || gitlab;
    return {
      repository,
      forge: known ? (gitlab ? "gitlab" : "github") : null,
      webUrl: known
        ? `https://${repository.host}/${repository.owner}/${repository.name}`
        : null,
    };
  },
} as unknown as ForgeService;

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

function refused(outcome: ControlOutcome): { status: number; code: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return { status: outcome.status, code: outcome.code };
}

beforeEach(async () => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
  member = result(
    await run(lead, "open-agent", {
      agent: "codex",
      task: "do it",
      "task-id": "s1:t1",
      name: "worker",
    }),
  ).id as string;
  pullBindDeps.current = {
    forge: () => stubForge,
    originUrl: async () => "git@github.com:acme/app.git",
  };
});

afterEach(() => {
  pullBindDeps.current = original;
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("parsePullRef", () => {
  it("accepts a number, #number and the three web forms", () => {
    expect(parsePullRef("12")).toEqual({ number: 12 });
    expect(parsePullRef("#12")).toEqual({ number: 12 });
    expect(parsePullRef("https://github.com/acme/app/pull/12")).toEqual({
      number: 12,
      remoteUrl: "https://github.com/acme/app",
    });
    expect(
      parsePullRef("https://git.example.com/acme/app/pulls/3?x=1"),
    ).toEqual({
      number: 3,
      remoteUrl: "https://git.example.com/acme/app",
    });
    expect(
      parsePullRef("https://gitlab.example.com/g/sub/app/-/merge_requests/9"),
    ).toEqual({
      number: 9,
      remoteUrl: "https://gitlab.example.com/g/sub/app",
    });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "0",
      "abc",
      "-3",
      "ssh://github.com/a/b/pull/1",
      "https://user:pw@github.com/a/b/pull/1",
      "https://github.com/a/b/issues/1",
      "https://github.com/pull/1",
      "",
    ]) {
      expect(parsePullRef(bad)).toBeUndefined();
    }
  });

  it("builds the page address per platform", () => {
    expect(pullUrl("github", "https://github.com/a/b", 4)).toBe(
      "https://github.com/a/b/pull/4",
    );
    expect(pullUrl("gitea", "https://g.example/a/b/", 4)).toBe(
      "https://g.example/a/b/pulls/4",
    );
    expect(pullUrl("gitlab", "https://gl.example/a/b", 4)).toBe(
      "https://gl.example/a/b/-/merge_requests/4",
    );
    expect(pullUrl("github", null, 4)).toBe("");
    expect(pullUrl("github", "javascript:alert(1)", 4)).toBe("");
  });
});

describe("report --pr", () => {
  it("binds the workspace remote's pull as the item's own", async () => {
    const body = result(
      await run(member, "report", {
        state: "ready",
        summary: "done",
        pr: "12",
      }),
    );
    expect(body.pull).toEqual({
      repo: "github.com/acme/app",
      number: 12,
      bound: true,
    });
    expect(taskRun(fixture.database, "s1:t1")!.threads).toEqual([
      {
        kind: "pull",
        repo: "github.com/acme/app",
        number: 12,
        own: true,
        url: "https://github.com/acme/app/pull/12",
        boundAt: expect.any(Number),
      },
    ]);
  });

  it("takes a web address of another repository, and binds it once", async () => {
    const pr = "https://gitlab.example.com/g/sub/app/-/merge_requests/9";
    const first = result(
      await run(member, "report", { state: "progress", summary: "a", pr }),
    );
    expect(first.pull).toMatchObject({
      repo: "gitlab.example.com/g/sub/app",
      number: 9,
      bound: true,
    });
    const again = result(
      await run(member, "report", { state: "ready", summary: "b", pr }),
    );
    expect((again.pull as { bound: boolean }).bound).toBe(false);
    expect(taskRun(fixture.database, "s1:t1")!.threads).toHaveLength(1);
  });

  it("refuses a bad reference, an unknown platform, and an unrecognizable number without writing the report", async () => {
    expect(
      refused(
        await run(member, "report", {
          state: "ready",
          summary: "x",
          pr: "nope",
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      refused(
        await run(member, "report", {
          state: "ready",
          summary: "x",
          pr: "https://git.example.org/a/b/pull/1",
        }),
      ),
    ).toMatchObject({ status: 400 });
    pullBindDeps.current = {
      ...pullBindDeps.current,
      originUrl: async () => undefined,
    };
    expect(
      refused(
        await run(member, "report", { state: "ready", summary: "x", pr: "5" }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      refused(
        await run(member, "report", { state: "ready", summary: "x", pr: true }),
      ),
    ).toMatchObject({ status: 400 });
    const row = taskRun(fixture.database, "s1:t1")!;
    expect(row.report).toBeNull();
    expect(row.threads).toEqual([]);
  });

  it("refuses when the item already watches the most pulls", async () => {
    for (let number = 1; number <= 5; number += 1) {
      result(
        await run(member, "report", {
          state: "progress",
          summary: "x",
          pr: String(number),
        }),
      );
    }
    expect(
      refused(
        await run(member, "report", {
          state: "progress",
          summary: "x",
          pr: "6",
        }),
      ),
    ).toMatchObject({ status: 409, code: "threads_full" });
  });
});

describe("items --bind-pr", () => {
  it("lets the coordinator watch a pull without making it the item's own", async () => {
    const body = result(
      await run(lead, "items", {
        item: "s1:t1",
        "bind-pr": "https://github.com/acme/app/pull/40",
      }),
    );
    expect(body).toMatchObject({ item: "s1:t1", bound: true });
    expect(taskRun(fixture.database, "s1:t1")!.threads[0]).toMatchObject({
      number: 40,
      own: false,
    });
    const detail = result(await run(lead, "items", { item: "s1:t1" }));
    expect(detail.pulls).toEqual([
      {
        repo: "github.com/acme/app",
        number: 40,
        own: false,
        url: "https://github.com/acme/app/pull/40",
      },
    ]);
  });

  it("is the coordinator's alone, and needs an item", async () => {
    expect(
      refused(await run(member, "items", { item: "s1:t1", "bind-pr": "3" })),
    ).toMatchObject({ status: 404, code: "item_not_found" });
    expect(refused(await run(lead, "items", { "bind-pr": "3" }))).toMatchObject(
      { status: 400 },
    );
    expect(
      refused(await run(lead, "items", { item: "nope", "bind-pr": "3" })),
    ).toMatchObject({ status: 404 });
    expect(taskRun(fixture.database, "s1:t1")!.threads).toEqual([]);
  });

  it("keeps the member's own flag when the coordinator names the same pull", async () => {
    result(
      await run(member, "report", { state: "ready", summary: "x", pr: "7" }),
    );
    const body = result(
      await run(lead, "items", { item: "s1:t1", "bind-pr": "7" }),
    );
    expect(body.bound).toBe(false);
    expect(taskRun(fixture.database, "s1:t1")!.threads[0]).toMatchObject({
      own: true,
    });
  });
});
