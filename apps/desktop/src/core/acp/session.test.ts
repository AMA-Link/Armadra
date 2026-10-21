import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceEvent } from "../bus";
import { tempDir } from "../testing/temp-dir";
import { type AcpHostSession, startAcp } from "./host";
import { AcpMirror, mirrorPath } from "./mirror";
import type { AcpSignal } from "./normalize";
import { AcpSession, type AcpSessionSink } from "./session";

/**
 * 一个 ACP 会话的协议侧语义（ACP 设计 §5.4–§5.7），对假 ACP Agent（真子进程），
 * 出口换成记录器：信号、事件、被取消的审批各记一份。
 */

const NODE = "11111111-2222-4333-8444-555555555555";
const sessions: AcpSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.terminate()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Recorder extends AcpSessionSink {
  readonly signals: { signal: AcpSignal; raw?: unknown }[];
  readonly events: WorkspaceEvent[];
  readonly cancelledIds: string[];
}

function recorder(): Recorder {
  const signals: { signal: AcpSignal; raw?: unknown }[] = [];
  const events: WorkspaceEvent[] = [];
  const cancelledIds: string[] = [];
  return {
    signals,
    events,
    cancelledIds,
    signal: (signal, raw) => signals.push({ signal, raw }),
    publish: (event) => events.push(event),
    cancelled: (pendingId) => cancelledIds.push(pendingId),
    transcriptPath: (_id, mirror) => mirror,
  };
}

async function open(
  options: { resume?: string; dataDir?: string } = {},
): Promise<{ session: AcpSession; sink: Recorder; dataDir: string }> {
  const dataDir = options.dataDir ?? tempDir("armadra-acp-session-");
  if (options.dataDir === undefined) dirs.push(dataDir);
  const sink = recorder();
  const session = new AcpSession({
    rowId: "row-1",
    generation: 1,
    nodeId: NODE,
    workspaceId: "ws",
    agentId: "claude",
    sink,
    mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
    resumeSessionId: options.resume,
  });
  const host: AcpHostSession = await startAcp({
    program: process.execPath,
    args: [fakeAcpAgentPath()],
    cwd: tmpdir(),
    ...(options.resume === undefined
      ? {}
      : { resume: { sessionId: options.resume, method: "load" } }),
    ...session.callbacks(),
  });
  session.opened(host);
  sessions.push(session);
  return { session, sink, dataDir };
}

async function until<T>(read: () => T, ready: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const kinds = (sink: Recorder) =>
  sink.signals.map((item) => item.signal.signal);
const turns = (sink: Recorder) =>
  sink.events.filter((event) => event.type === "acp.turn");

describe("an ACP session", () => {
  it("says opened, then prompt / turn around each turn, and writes no mirror", async () => {
    const { session, sink, dataDir } = await open();
    expect(sink.signals[0]?.signal).toMatchObject({
      signal: "opened",
      sessionId: session.acpSessionId,
    });
    const turnId = session.prompt("hi");
    expect(turnId).toBe("1-1");
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(kinds(sink)).toEqual(["opened", "prompt", "turn"]);
    expect(turns(sink)[0]).toMatchObject({
      sessionId: "row-1",
      nodeId: NODE,
      turnId,
      stopReason: "end_turn",
    });
    // 会话内容只进时间线（`timeline-ingest.test.ts`）：不再写镜像，也不再发 acp.update。
    expect(sink.events.map((event) => event.type as string)).not.toContain(
      "acp.update",
    );
    expect(existsSync(mirrorPath(dataDir, NODE, session.acpSessionId!))).toBe(
      false,
    );
  });

  it("remembers the plan and usage of the live process for the log snapshot (§49)", async () => {
    const { session, sink } = await open();
    expect(session.snapshot()).toEqual({
      plan: [],
      usage: null,
      availableCommands: [],
      title: null,
    });
    session.prompt("[plan] go");
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    const snapshot = session.snapshot();
    expect(snapshot.plan.length).toBeGreaterThan(0);
    expect(snapshot.plan[0]).toHaveProperty("content");
    expect(snapshot.usage).toMatchObject({ size: 1000 });
  });

  it("queues prompts: one turn at a time", async () => {
    const { session, sink } = await open();
    session.prompt("one");
    session.prompt("two");
    expect(session.busy).toBe(true);
    await until(
      () => turns(sink).length,
      (count) => count === 2,
    );
    expect(kinds(sink)).toEqual(["opened", "prompt", "turn", "prompt", "turn"]);
    expect(session.busy).toBe(false);
  });

  it("holds a permission as blocked, and answers it with the agent's own option", async () => {
    const { session, sink } = await open();
    session.prompt("[permission]");
    const asked = await until(
      () => sink.signals.find((item) => item.signal.signal === "permission"),
      (item) => item !== undefined,
    );
    const pendingId = (asked!.signal as { pendingId: string }).pendingId;
    expect(asked!.raw).toMatchObject({
      protocol: "acp",
      toolCall: { toolCallId: "call-1" },
    });
    expect(session.pending().map((item) => item.pendingId)).toEqual([
      pendingId,
    ]);
    expect(session.owns(pendingId)).toBe(true);
    // 不认识的选项：不答。
    expect(session.answer(pendingId, "bogus")).toBe(false);
    expect(session.answer(pendingId, "allow")).toBe(true);
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(kinds(sink)).toContain("permissionSettled");
    expect(sink.cancelledIds).toEqual([]);
    expect(session.pending()).toEqual([]);
  });

  it("settles every pending approval as cancelled when the turn is cancelled", async () => {
    const { session, sink } = await open();
    session.prompt("[permission]");
    const asked = await until(
      () => sink.signals.find((item) => item.signal.signal === "permission"),
      (item) => item !== undefined,
    );
    const pendingId = (asked!.signal as { pendingId: string }).pendingId;
    await session.cancel();
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(sink.cancelledIds).toEqual([pendingId]);
    expect(turns(sink)[0]).toMatchObject({ stopReason: "cancelled" });
    // 已经结束的那条再答不进去。
    expect(session.answer(pendingId, "allow")).toBe(false);
  });

  it("settles a pending approval as cancelled when the adapter goes away", async () => {
    const { session, sink } = await open();
    session.prompt("[permission]");
    const asked = await until(
      () => sink.signals.find((item) => item.signal.signal === "permission"),
      (item) => item !== undefined,
    );
    const pendingId = (asked!.signal as { pendingId: string }).pendingId;
    await session.terminate();
    await until(
      () => sink.cancelledIds.length,
      (count) => count === 1,
    );
    expect(sink.cancelledIds).toEqual([pendingId]);
    expect(session.alive).toBe(false);
    expect(() => session.prompt("again")).toThrow(/not running/);
  });

  it("never writes the replay of a load into the mirror and never publishes it", async () => {
    const dataDir = tempDir("armadra-acp-replay-");
    dirs.push(dataDir);
    const first = await open({ resume: "fake-7", dataDir });
    expect(first.session.resumed).toBe(true);
    expect(
      first.sink.events.map((event) => event.type as string),
    ).not.toContain("acp.update");
    expect(existsSync(mirrorPath(dataDir, NODE, "fake-7"))).toBe(false);
    await first.session.terminate();
    expect(new AcpMirror(mirrorPath(dataDir, NODE, "fake-7")).empty).toBe(true);
  });
});
