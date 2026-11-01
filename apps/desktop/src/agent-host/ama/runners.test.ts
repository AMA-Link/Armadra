import { describe, expect, it, vi } from "vitest";
import type {
  HostApi,
  HostRunner,
  RunnerDoneEvent,
  SubagentEvent,
  SubagentRunRequest,
} from "@armadra/agent/host";
import type { JsonValue } from "../../hook-client/json";
import type { ControlAnswer } from "./client";
import {
  BUILTIN_RUNNER_IDS,
  type RunnerDeps,
  canvasMode,
  canvasRunner,
  provideRunners,
  RUNNER_DONE_EVENT,
  resultKeyFor,
  taskKey,
} from "./runners";

/**
 * The canvas runners against a scripted core: what they send to which verb,
 * and what they make of the answers (contract §15.5).
 */

type Call = { verb: string; args: Record<string, JsonValue> };

function scriptedCore(
  answer: (call: Call, calls: Call[]) => ControlAnswer | Promise<ControlAnswer>,
) {
  const calls: Call[] = [];
  const control = vi.fn(
    async (verb: string, args: Record<string, JsonValue>) => {
      const call = { verb, args };
      calls.push(call);
      return answer(call, calls);
    },
  );
  return { calls, control };
}

const ok = (result: unknown): ControlAnswer => ({
  kind: "ok",
  body: { ok: true, message: "", result },
});

function deps(
  control: RunnerDeps["control"],
  extra: Partial<RunnerDeps> = {},
): RunnerDeps & { status: Map<string, string | undefined> } {
  const status = new Map<string, string | undefined>();
  return {
    coordinatorNodeId: "lead-node",
    sessionId: () => "sess-1",
    control,
    context: vi.fn(async () => "summary of the member"),
    setStatus: (key, text) => {
      status.set(key, text);
    },
    log: vi.fn(),
    retryMs: 1,
    status,
    ...extra,
  };
}

function request(
  overrides: Partial<SubagentRunRequest> = {},
): SubagentRunRequest & { events: SubagentEvent[] } {
  const events: SubagentEvent[] = [];
  return {
    prompt: "review src/x",
    cwd: "/work",
    mode: "full-auto",
    taskId: "t1",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    events,
    ...overrides,
  };
}

/** A core that hands out node ids by task id, the way `--task-id` does. */
function openAgentAnswer(nodes: Map<string, string>, call: Call) {
  const key = String(call.args["task-id"]);
  const existing = nodes.get(key);
  const id = existing ?? `node-${nodes.size + 1}`;
  nodes.set(key, id);
  return ok({ id, reused: existing !== undefined });
}

describe("the canvas runners", () => {
  it("maps ama's modes onto the canvas CLIs'", () => {
    expect(canvasMode("plan")).toBe("plan");
    expect(canvasMode("auto-edit")).toBe("auto-edit");
    expect(canvasMode("auto")).toBe("full-auto");
    expect(canvasMode("full-auto")).toBe("full-auto");
    expect(canvasMode("default")).toBe("default");
    expect(canvasMode("allowlist")).toBe("default");
  });

  it("scopes ama's task id by session and keeps it a valid key", () => {
    expect(taskKey("sess-1", "t1")).toBe("sess-1:t1");
    expect(taskKey("a/b c", "t 2")).toBe("abc:t2");
    expect(taskKey("s", undefined)).toMatch(/^s:[0-9a-f-]+$/);
    expect(resultKeyFor("s:t1", 1)).toBe("task:s:t1:result");
    expect(resultKeyFor("s:t1", 2)).toBe("task:s:t1:result:2");
  });

  it("starts idempotently: the same task id is the same node", async () => {
    const nodes = new Map<string, string>();
    const core = scriptedCore((call) =>
      call.verb === "open-agent" ? openAgentAnswer(nodes, call) : ok({}),
    );
    const runner = canvasRunner("claude", deps(core.control));
    const first = await runner.start(request());
    const retry = await runner.start(request());
    expect(first.id).toBe("node-1");
    expect(retry.id).toBe("node-1");
    const open = core.calls.filter((call) => call.verb === "open-agent");
    expect(open).toHaveLength(2);
    expect(open[0]!.args).toMatchObject({
      agent: "claude",
      "task-id": "sess-1:t1",
      "permission-mode": "full-auto",
      // The work item's title is the first line of the dispatch text.
      "item-title": "review src/x",
    });
    // The member is told exactly which key the coordinator waits for.
    expect(String(open[0]!.args.task)).toContain("review src/x");
    expect(String(open[0]!.args.task)).toContain(
      "--to lead-node --key task:sess-1:t1:result",
    );
  });

  it("falls back to the CLI's default mode, never for plan", async () => {
    const core = scriptedCore((call) =>
      call.args["permission-mode"] !== undefined
        ? {
            kind: "refused",
            status: 400,
            code: "permission_mode_unsupported",
            message: "no such mode",
          }
        : ok({ id: "node-1" }),
    );
    const runner = canvasRunner("opencode", deps(core.control));
    const handle = await runner.start(request({ mode: "auto-edit" }));
    expect(handle.id).toBe("node-1");
    expect(core.calls.map((call) => call.args["permission-mode"])).toEqual([
      "auto-edit",
      undefined,
    ]);
    await expect(runner.start(request({ mode: "plan" }))).rejects.toThrow(
      /permission_mode_unsupported/,
    );
  });

  it("passes ama's cwd and resume to open-agent", async () => {
    const core = scriptedCore(() => ok({ id: "node-1" }));
    const runner = canvasRunner("claude", deps(core.control));
    await runner.start(request({ cwd: "/work/src", resume: "member-node" }));
    expect(core.calls[0]!.args).toMatchObject({
      cwd: "/work/src",
      resume: "member-node",
    });
    await runner.start(request({ cwd: "" }));
    expect("cwd" in core.calls[1]!.args).toBe(false);
    expect("resume" in core.calls[1]!.args).toBe(false);
  });

  it("drops a cwd or resume the core turns down and starts anyway", async () => {
    const refused = (code: string): ControlAnswer => ({
      kind: "refused",
      status: 400,
      code,
      message: code,
    });
    const core = scriptedCore((call) =>
      call.args.cwd !== undefined
        ? refused("cwd_outside_workspace")
        : call.args.resume !== undefined
          ? refused("resume_unsupported")
          : call.args["permission-mode"] !== undefined
            ? refused("permission_mode_unsupported")
            : ok({ id: "node-1" }),
    );
    const d = deps(core.control);
    const handle = await canvasRunner("opencode", d).start(
      request({ cwd: "/elsewhere", resume: "s-1", mode: "auto-edit" }),
    );
    expect(handle.id).toBe("node-1");
    expect(
      core.calls.map((call) =>
        ["cwd", "resume", "permission-mode"].filter(
          (name) => name in call.args,
        ),
      ),
    ).toEqual([
      ["cwd", "resume", "permission-mode"],
      ["resume", "permission-mode"],
      ["permission-mode"],
      [],
    ]);
    expect(d.log).toHaveBeenCalledTimes(3);
  });

  it("does not drop what the core did not complain about", async () => {
    const core = scriptedCore(() => ({
      kind: "refused",
      status: 400,
      code: "bad_request",
      message: "--cwd 的目录不存在",
    }));
    await expect(
      canvasRunner("claude", deps(core.control)).start(
        request({ cwd: "/work/missing" }),
      ),
    ).rejects.toThrow(/bad_request/);
    expect(core.calls).toHaveLength(1);
  });

  it("waits through blocked and needsInput without answering, then returns the posted result", async () => {
    const answers = [
      ok({
        status: "running",
        since: "0-working",
        events: [{ type: "status", state: "working" }],
      }),
      ok({
        status: "blocked",
        since: "0-blocked",
        approvalId: "approval-1",
        events: [{ type: "status", state: "blocked" }],
      }),
      ok({
        status: "needsInput",
        since: "0-waiting",
        events: [{ type: "status", state: "waiting" }],
      }),
      ok({
        status: "done",
        since: "7-working",
        events: [
          { type: "status", state: "working" },
          { type: "post", key: "task:sess-1:t1:result", body: "x is fine" },
        ],
        result: { text: "x is fine" },
      }),
    ];
    const core = scriptedCore((call) =>
      call.verb === "open-agent"
        ? ok({ id: "node-1" })
        : call.verb === "wait"
          ? answers.shift()!
          : ok({}),
    );
    const statuses: (string | undefined)[] = [];
    const d = deps(core.control, {
      setStatus: (_key: string, text?: string) => {
        statuses.push(text);
      },
    });
    const req = request();
    const handle = await canvasRunner("codex", d).start(req);
    const result = await handle.wait();
    expect(result).toMatchObject({
      text: "x is fine",
      isError: false,
      status: "completed",
    });
    const waits = core.calls.filter((call) => call.verb === "wait");
    expect(waits.map((call) => call.args.since)).toEqual([
      undefined,
      "0-working",
      "0-blocked",
      "0-waiting",
    ]);
    expect(waits[0]!.args).toMatchObject({
      task: "sess-1:t1",
      node: "node-1",
      timeout: "30",
    });
    // Only `wait` was asked; nothing answered the approval.
    expect(
      core.calls.filter((call) => !["open-agent", "wait"].includes(call.verb)),
    ).toEqual([]);
    expect(statuses).toContain("t1: 等人审批 / awaiting approval");
    expect(statuses.at(-1)).toBeUndefined();
    expect(req.events).toEqual([
      { type: "turn", turn: 1 },
      { type: "turn", turn: 2 },
      { type: "text", delta: "x is fine\n" },
    ]);
  });

  it("falls back to the member's summary, and reports a failure as an error", async () => {
    const answers = [
      ok({ status: "done", since: "0-done", events: [] }),
      ok({ status: "failed", since: "0", events: [], reason: "nodeDeleted" }),
    ];
    const core = scriptedCore((call) =>
      call.verb === "open-agent" ? ok({ id: "node-1" }) : answers.shift()!,
    );
    const d = deps(core.control);
    const runner = canvasRunner("codex", d);
    expect(await (await runner.start(request())).wait()).toMatchObject({
      text: "summary of the member",
      isError: false,
    });
    expect(d.context).toHaveBeenCalledWith("summary", { node: "node-1" });
    expect(await (await runner.start(request())).wait()).toMatchObject({
      isError: true,
      status: "failed",
    });
  });

  it("on abort only interrupts the member; the node stays", async () => {
    const controller = new AbortController();
    const core = scriptedCore((call) => {
      if (call.verb === "open-agent") return ok({ id: "node-1" });
      if (call.verb === "wait") {
        controller.abort();
        return ok({ status: "running", since: "0", events: [] });
      }
      return ok({});
    });
    const handle = await canvasRunner("claude", deps(core.control)).start(
      request({ signal: controller.signal }),
    );
    const result = await handle.wait();
    expect(result).toMatchObject({ status: "aborted", isError: true });
    expect(core.calls.map((call) => call.verb)).toEqual([
      "open-agent",
      "wait",
      "interrupt",
    ]);
    expect(core.calls.at(-1)!.args).toEqual({ to: "node-1" });
  });

  it("sends a follow-up through the queue with the next round's key", async () => {
    const core = scriptedCore((call) =>
      call.verb === "open-agent" ? ok({ id: "node-1" }) : ok({}),
    );
    const handle = await canvasRunner("claude", deps(core.control)).start(
      request(),
    );
    await handle.send("also check y");
    const send = core.calls.find((call) => call.verb === "send")!;
    expect(send.args.to).toBe("node-1");
    expect(String(send.args.body)).toContain("also check y");
    expect(String(send.args.body)).toContain("task:sess-1:t1:result:2");
    await handle.stop();
    expect(core.calls.at(-1)).toEqual({
      verb: "interrupt",
      args: { to: "node-1" },
    });
  });

  it("gives up after the core stays unreachable", async () => {
    const core = scriptedCore((call) =>
      call.verb === "open-agent"
        ? ok({ id: "node-1" })
        : { kind: "unreachable", error: "nobody listening" },
    );
    const handle = await canvasRunner("claude", deps(core.control)).start(
      request(),
    );
    expect(await handle.wait()).toMatchObject({
      isError: true,
      text: "nobody listening",
    });
  });

  it("provides one runner per built-in and per custom agent the core lists", async () => {
    const provided: HostRunner[] = [];
    const released: string[] = [];
    const core = scriptedCore((call) =>
      call.verb === "help"
        ? ok({ agents: ["claude", "ama", "custom:review", "custom:bad id"] })
        : ok({}),
    );
    const api = {
      env: { ARMADRA_NODE_ID: "lead-node" },
      runners: {
        provide: (runner: HostRunner) => {
          provided.push(runner);
          return () => released.push(runner.id);
        },
      },
      session: { id: () => "sess-1" },
      ui: { setStatus: vi.fn() },
      log: vi.fn(),
    } as unknown as HostApi;
    const release = provideRunners(api, { control: core.control });
    await vi.waitFor(() => {
      expect(provided.map((runner) => runner.id)).toContain("custom:review");
    });
    expect(provided.map((runner) => runner.id)).toEqual([
      ...BUILTIN_RUNNER_IDS,
      "custom:review",
    ]);
    // `ama` too: another ama node on the board (ama ≥ 0.6.7 calls it).
    expect(provided[0]?.id).toBe("ama");
    expect(provided.every((runner) => runner.description !== "")).toBe(true);
    release();
    expect(released).toHaveLength(BUILTIN_RUNNER_IDS.length + 1);

    // An older ama without the surface: nothing to provide.
    expect(() =>
      provideRunners({ ...api, runners: undefined } as unknown as HostApi)(),
    ).not.toThrow();
  });
});

describe("runner_done (host-api 1.1 runners.onDone)", () => {
  function doneEvent(
    overrides: Partial<RunnerDoneEvent> = {},
  ): RunnerDoneEvent {
    return {
      runner: "claude",
      taskId: "t1",
      sessionId: "node-1",
      round: 1,
      status: "aborted",
      isError: true,
      error: "stopped",
      startedAt: 1_000,
      endedAt: 3_000,
      durationMs: 2_000,
      ...overrides,
    };
  }

  function amaWith(onDone: unknown) {
    const provided: HostRunner[] = [];
    let session = "sess-1";
    const api = {
      env: { ARMADRA_NODE_ID: "lead-node" },
      runners: {
        provide: (runner: HostRunner) => {
          provided.push(runner);
          return () => undefined;
        },
        ...(onDone === undefined ? {} : { onDone }),
      },
      session: { id: () => session },
      ui: { setStatus: vi.fn() },
      log: vi.fn(),
    } as unknown as HostApi;
    return {
      api,
      provided,
      moveSession: (next: string) => {
        session = next;
      },
    };
  }

  it("subscribes on a new ama and reports each round under the board's task key", async () => {
    let handler: ((event: RunnerDoneEvent) => void) | undefined;
    const unsubscribed = vi.fn();
    const onDone = vi.fn((next: (event: RunnerDoneEvent) => void) => {
      handler = next;
      return unsubscribed;
    });
    const ama = amaWith(onDone);
    const reported: Record<string, JsonValue>[] = [];
    const core = scriptedCore((call) =>
      call.verb === "open-agent" ? ok({ id: "node-1" }) : ok({}),
    );
    const release = provideRunners(ama.api, {
      control: core.control,
      report: async (payload) => {
        reported.push(payload);
      },
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    const claude = ama.provided.find((runner) => runner.id === "claude");
    await claude?.start(request());
    // The session moved on after start: the key is the one start used.
    ama.moveSession("sess-2");
    handler?.(doneEvent());
    expect(reported).toEqual([
      {
        hookEventName: RUNNER_DONE_EVENT,
        provider: "ama",
        sessionId: "sess-2",
        taskId: taskKey("sess-1", "t1"),
        round: 1,
        status: "aborted",
        isError: true,
        endedAt: 3_000,
      },
    ]);
    expect(JSON.stringify(reported)).not.toContain("stopped");

    // A handle it never started: the key falls back to session + task id.
    handler?.(doneEvent({ sessionId: "node-9", taskId: "t2", round: 2 }));
    expect(reported.at(-1)).toMatchObject({
      taskId: taskKey("sess-2", "t2"),
      round: 2,
    });
    // Not one of this adapter's runners, or no way to name the task: nothing.
    handler?.(doneEvent({ runner: "general" }));
    handler?.(doneEvent({ sessionId: "node-9", taskId: undefined }));
    expect(reported).toHaveLength(2);

    release();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    handler?.(doneEvent());
    expect(reported).toHaveLength(2);
  });

  it("subscribes nothing on an older ama without onDone", async () => {
    const ama = amaWith(undefined);
    const report = vi.fn(async () => undefined);
    const core = scriptedCore(() => ok({ id: "node-1" }));
    const release = provideRunners(ama.api, { control: core.control, report });
    expect(ama.provided.map((runner) => runner.id)).toEqual([
      ...BUILTIN_RUNNER_IDS,
    ]);
    expect("onDone" in (ama.api.runners ?? {})).toBe(false);
    const claude = ama.provided.find((runner) => runner.id === "claude");
    const handle = await claude?.start(request());
    expect(handle?.id).toBe("node-1");
    expect(() => release()).not.toThrow();
    expect(report).not.toHaveBeenCalled();
    expect(ama.api.log).not.toHaveBeenCalled();
  });

  it("survives an onDone that throws when subscribing", () => {
    const ama = amaWith(() => {
      throw new Error("boom");
    });
    const core = scriptedCore(() => ok({}));
    expect(() =>
      provideRunners(ama.api, { control: core.control })(),
    ).not.toThrow();
    expect(ama.api.log).toHaveBeenCalledWith(
      "warn",
      "could not subscribe to runner completions",
      expect.any(Error),
    );
  });
});
