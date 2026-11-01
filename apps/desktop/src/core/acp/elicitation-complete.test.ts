import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AcpElicitationSettlement, AcpPendingElicitation } from "./client";
import { acpClientFeatures } from "./client";
import { type AcpHostSession, startAcp } from "./host";
import { until } from "./fixture";
import { AcpMirror, mirrorPath } from "./mirror";
import type { AcpSignal } from "./normalize";
import { AcpSession, type AcpSessionSink } from "./session";
import { tempDir } from "../testing/temp-dir";

/**
 * `elicitation/complete`（P2-6）：新版客户端把 Agent 的通知交给宿主，宿主按
 * `elicitationId` 收掉对应的 URL 模式卡片。0.11.0 的客户端没有这个回调，所以
 * 通知本身由 `AcpProcess.completeElicitation` 这一层接，这里直接驱动它。
 */

const AGENT = fileURLToPath(
  new URL("./url-elicit-agent.fixture.mjs", import.meta.url),
);

const open: AcpHostSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.process.terminate()));
});

async function start() {
  const pending: AcpPendingElicitation[] = [];
  const settled: AcpElicitationSettlement[] = [];
  const session = await startAcp({
    program: process.execPath,
    args: [AGENT],
    cwd: tmpdir(),
    onElicitation: (item) => pending.push(item),
    onElicitationSettled: (_item, settlement) => settled.push(settlement),
  });
  open.push(session);
  return { session, pending, settled };
}

describe("elicitation/complete", () => {
  it("is only wired when the client says it can take the callback", () => {
    expect(acpClientFeatures().elicitationComplete).toBe(false);
    expect(
      acpClientFeatures({ features: { elicitationComplete: true } })
        .elicitationComplete,
    ).toBe(true);
    // 声明成别的值不算。
    expect(
      acpClientFeatures({ features: { elicitationComplete: "yes" } })
        .elicitationComplete,
    ).toBe(false);
  });

  it("closes the matching pending URL request and answers it accept", async () => {
    const { session, pending, settled } = await start();
    const turn = session.process.prompt(session.sessionId, [
      { type: "text", text: "go" },
    ]);
    await until(
      () => pending.length,
      (count) => count === 1,
    );
    expect(pending[0]?.request.elicitationId).toBe("el-1");
    // 不认识的 id 什么也不动。
    expect(session.process.completeElicitation("nope")).toBe(false);
    expect(session.process.pendingElicitations()).toHaveLength(1);

    expect(session.process.completeElicitation("el-1")).toBe(true);
    await expect(turn).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(settled).toEqual([
      { by: "completed", result: { action: "accept" } },
    ]);
    expect(session.process.pendingElicitations()).toHaveLength(0);
    // 已经收掉的再来一次不重复。
    expect(session.process.completeElicitation("el-1")).toBe(false);
  });
});

describe("elicitation/complete on a session", () => {
  const NODE = "11111111-2222-4333-8444-555555555555";

  it("settles the approval row without an answer, like a cancel but accept", async () => {
    const dataDir = tempDir("armadra-acp-complete-");
    const cancelled: string[] = [];
    const signals: AcpSignal[] = [];
    const sink: AcpSessionSink = {
      signal: (signal) => signals.push(signal),
      publish: () => undefined,
      cancelled: (pendingId) => cancelled.push(pendingId),
      transcriptPath: (_id, mirror) => mirror,
    };
    const session = new AcpSession({
      rowId: "row-1",
      generation: 1,
      nodeId: NODE,
      workspaceId: "w1",
      agentId: "claude",
      sink,
      mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
    });
    const host = await startAcp({
      program: process.execPath,
      args: [AGENT],
      cwd: tmpdir(),
      ...session.callbacks(),
    });
    session.opened(host);
    try {
      session.prompt("go");
      const pendingId = await until(
        () => session.pendingElicitations()[0]?.pendingId,
        (id) => id !== undefined,
      );
      expect(host.process.completeElicitation("el-1")).toBe(true);
      await until(
        () => session.pendingElicitations().length,
        (count) => count === 0,
      );
      expect(cancelled).toEqual([pendingId]);
      expect(session.owns(pendingId as string)).toBe(false);
    } finally {
      await session.terminate();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
