import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import { launchFor } from "../../dependencies/store";
import { setRemoteCaller } from "../../remote/execute";
import { OPERATIONS } from "../../remote/operations";
import { RemoteError } from "../../remote/worker";
import { RepositoryService } from "../../git/repository/service";
import { type ControlOutcome, controlDispatcher } from ".";
import { resetSendLimits } from "../send-limits";
import { resetInboxWake } from "../wake";
import { resetWaitTrackers } from "./wait";

/**
 * 协调者成员的 `--cwd` / `--resume`（契约 §15.5，G5-07）：远端工作区里成员起
 * 在执行主机上、`--cwd` 由那台主机的 Worker 判定；`team` 的 `--cwd` 与成员级
 * `cwd=` / `resume=`。
 */

let fixture: AgentFixture;
let lead: string;
const HOST = "box";

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

function nodeData(nodeId: string): Record<string, unknown> {
  const row = fixture.database
    .prepare("SELECT data_json FROM nodes WHERE id = ?")
    .get(nodeId) as { data_json: string };
  return JSON.parse(row.data_json) as Record<string, unknown>;
}

/** 把夹具的工作区挂到执行主机上，Worker 由本进程里的操作表替身。 */
function remoteWorkspace(reachable = true): string[] {
  fixture.database
    .prepare("UPDATE workspaces SET execution_host_id = ? WHERE id = ?")
    .run(HOST, fixture.workspaceId);
  const calls: string[] = [];
  const local = { service: new RepositoryService(), freshDiscovery: true };
  setRemoteCaller(async (hostId, operation, payload) => {
    calls.push(`${hostId}:${operation}`);
    if (!reachable) {
      throw new RemoteError(503, "host_unreachable", "Box is offline");
    }
    const { root, args } = payload as {
      root: string;
      args: Record<string, unknown>;
    };
    return await OPERATIONS[operation]!.run(local, root, args);
  });
  return calls;
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
});

afterEach(() => {
  setRemoteCaller(undefined);
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

/** 执行主机一律是 POSIX：替身 Worker 跑在本进程里，Windows 上的路径对不上。 */
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("open-agent in a workspace on an execution host", () => {
  it("runs the member on that host, in the directory its Worker resolved", async () => {
    mkdirSync(join(fixture.directory, "src", "app"), { recursive: true });
    const calls = remoteWorkspace();
    const relative = result(
      await run(lead, "open-agent", { agent: "claude", cwd: "src/app" }),
    );
    expect(calls).toEqual([`${HOST}:files.list`]);
    const data = nodeData(relative.id as string);
    expect(data.ssh).toEqual({ hostId: HOST });
    expect(data.cwd).toBe(join(fixture.directory, "src", "app"));
    const absolute = result(
      await run(lead, "open-agent", {
        agent: "claude",
        cwd: join(fixture.directory, "src"),
      }),
    );
    expect(absolute.cwd).toBe(join(fixture.directory, "src"));
    const rooted = result(
      await run(lead, "open-agent", { agent: "claude", cwd: "." }),
    );
    expect(rooted.cwd).toBe(fixture.directory);
    // 不带 --cwd 也起在执行主机上：开在工作区根。
    const bare = result(await run(lead, "open-agent", { agent: "codex" }));
    expect(nodeData(bare.id as string)).toMatchObject({
      ssh: { hostId: HOST },
    });
    expect(nodeData(bare.id as string).cwd).toBeUndefined();
  });

  it("answers the local refusal codes, and cwd_unsupported when the host is unreachable", async () => {
    const outside = mkdtempSync(join(tmpdir(), "armadra-outside-"));
    try {
      symlinkSync(outside, join(fixture.directory, "escape"));
      remoteWorkspace();
      for (const cwd of ["..", outside, "escape"]) {
        expect(
          await run(lead, "open-agent", { agent: "claude", cwd }),
        ).toMatchObject({ ok: false, code: "cwd_outside_workspace" });
      }
      expect(
        await run(lead, "open-agent", { agent: "claude", cwd: "nope" }),
      ).toMatchObject({ ok: false, status: 400, code: "bad_request" });
      expect(
        await run(lead, "open-agent", { agent: "claude", cwd: "canvas.db" }),
      ).toMatchObject({ ok: false, status: 400, code: "bad_request" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    remoteWorkspace(false);
    expect(
      await run(lead, "open-agent", { agent: "claude", cwd: "." }),
    ).toMatchObject({ ok: false, status: 400, code: "cwd_unsupported" });
  });
});

describe("team --cwd, cwd= and resume=", () => {
  it("opens members in the team's directory, a member's own cwd= first, a worktree member left alone", async () => {
    mkdirSync(join(fixture.directory, "api"), { recursive: true });
    mkdirSync(join(fixture.directory, "web"), { recursive: true });
    const body = result(
      await run(lead, "team", {
        member: [
          "codex|后端|改 api",
          "claude|前端|改 web|cwd=web",
          "claude|根||cwd=.",
        ],
        cwd: "api",
      }),
    );
    const rows = body.members as Record<string, unknown>[];
    expect(rows.map((row) => row.cwd)).toEqual([
      join(fixture.directory, "api"),
      join(fixture.directory, "web"),
      fixture.directory,
    ]);
    expect(nodeData(rows[1]!.id as string).cwd).toBe(
      join(fixture.directory, "web"),
    );
    // 任务正文里没有被当成选项摘掉。
    const queued = fixture.database
      .prepare(
        "SELECT body FROM agent_send_queue WHERE target_node_id = ? AND origin = 'first-task'",
      )
      .all(rows[1]!.id as string) as { body: string }[];
    expect(queued.map((row) => row.body)).toEqual(["改 web"]);
  });

  it("resumes a member's session and has the core start it", async () => {
    const body = result(
      await run(lead, "team", {
        member: [
          "claude|续上|接着做|resume=0199aa00-1111-7222-8333-444455556666",
          "codex|新开|另起一件",
        ],
      }),
    );
    const [resumed, fresh] = body.members as Record<string, unknown>[];
    expect(resumed!.resume).toBe("0199aa00-1111-7222-8333-444455556666");
    const agent = nodeData(resumed!.id as string).agent as Record<
      string,
      unknown
    >;
    expect(agent.resume).toBe("0199aa00-1111-7222-8333-444455556666");
    expect(launchFor(fixture.database, resumed!.id as string)).toMatchObject({
      state: "waiting",
    });
    expect(fresh!.resume).toBeUndefined();
    expect(launchFor(fixture.database, fresh!.id as string)).toBeUndefined();
  });

  it("refuses bad options before creating any member", async () => {
    const count = () =>
      Number(
        (
          fixture.database.prepare("SELECT COUNT(*) AS n FROM nodes").get() as {
            n: number;
          }
        ).n,
      );
    const before = count();
    for (const args of [
      { member: ["claude|a|b|cwd=nope"] },
      { member: ["claude|a|b"], cwd: ".." },
      { member: ["claude|a||cwd=.|worktree=fix"] },
      { member: ["claude|a||cwd=.|cwd=."] },
      { member: ["claude|a||resume=a b"] },
    ]) {
      expect(await run(lead, "team", args)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    fixture.customAgents.push({
      id: "custom:once",
      label: "once",
      launchCmd: "once",
      baseAgent: "claude",
      disabledCapabilities: ["resume"],
    });
    expect(
      await run(lead, "team", { member: ["custom:once|a||resume=s-1"] }),
    ).toMatchObject({ ok: false, code: "resume_unsupported" });
    expect(count()).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "puts team members of a remote workspace on the execution host",
    async () => {
      mkdirSync(join(fixture.directory, "api"), { recursive: true });
      remoteWorkspace();
      const body = result(
        await run(lead, "team", {
          member: ["codex|一|x", "claude|二|y"],
          cwd: "api",
        }),
      );
      for (const row of body.members as Record<string, unknown>[]) {
        expect(nodeData(row.id as string)).toMatchObject({
          ssh: { hostId: HOST },
          cwd: join(fixture.directory, "api"),
        });
      }
    },
  );
});
