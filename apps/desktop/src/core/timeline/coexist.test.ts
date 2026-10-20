import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AcpCore, FAKE_AGENT, acpCore, until } from "../acp/fixture";
import type { WorkspaceEvent } from "../bus";
import { type Kit, startKit } from "../contract/parity-kit";
import { installContract } from "../http/rpc";
import { type TimelineDomain, install } from ".";
import { msg, turnCtx } from "./testing";

/**
 * 旧接口（`acp.log` 镜像读、`acp.update` / `acp.turn` 事件）与新接口（`timeline.*`）
 * 同时存在期间的行为（B10 之前两边都在）：装上时间线域不改变 ACP 会话的任何旧行为；
 * 时间线是另一份数据，没有人写它之前 `timeline.*` 答 404，页面据此退回旧路径；
 * 有人写了之后两边各读各的，互不影响。
 */

let open: AcpCore;
let kit: Kit;
let domain: TimelineDomain;
let seen: WorkspaceEvent[];
let sessionId: string;
let nodeId: string;

beforeAll(async () => {
  open = await acpCore();
  domain = install(open.core) as TimelineDomain;
  installContract(open.core.server, {
    validateOutput: true,
    platform: open.core.platform,
  });
  kit = await startKit(open.core.server, () => undefined);
  seen = [];
  open.core.bus.on("workspace.event", ({ event }) => seen.push(event));
  nodeId = await open.node();
  const created = await open.core.call("POST", "/api/acp/sessions", {
    workspaceId: open.workspaceId,
    nodeId,
    cwd: open.core.directory,
    agentId: FAKE_AGENT,
    prompt: "你好",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  sessionId = (created.body as { id: string }).id;
  await until(
    () => seen.filter((event) => event.type === "acp.turn"),
    (turns) => turns.length > 0,
  );
});

afterAll(async () => {
  await open.core.server.close();
  await open.stop();
});

describe("旧接口与新接口同时存在", () => {
  it("旧接口照旧：acp.update / acp.turn 事件发出，acp.log 读得到镜像", async () => {
    expect(seen.some((e) => e.type === "acp.update")).toBe(true);
    const log = await open.core.call(
      "GET",
      `/api/acp/sessions/${sessionId}/log`,
    );
    expect(log.status).toBe(200);
    expect(
      (log.body as { entries: unknown[] }).entries.length,
    ).toBeGreaterThanOrEqual(2);
    // 没有生产者接上之前，时间线不发任何帧。
    expect(seen.filter((e) => e.type === "timeline.delta")).toHaveLength(0);
  });

  it("还没有人写时间线：timeline.open 答 404，会话列表没有 activity（页面退回 acp.log）", async () => {
    const answer = await kit.procedure("timeline.open", {
      timelineId: sessionId,
    });
    expect(answer.status).toBe(404);
    const list = (
      await open.core.call(
        "GET",
        `/api/workspaces/${open.workspaceId}/sessions`,
      )
    ).body as { sessionId: string; activity?: unknown }[];
    const row = list.find((r) => r.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("activity");
  });

  it("有人开始写之后：两边各读各的，timeline.* 与 sessions.list 都有了；acp.log 不受影响", async () => {
    const logBefore = JSON.stringify(
      (await open.core.call("GET", `/api/acp/sessions/${sessionId}/log`)).body,
    );
    domain.open({
      timelineId: sessionId,
      workspaceId: open.workspaceId,
      nodeId,
    });
    domain.writer.turnBegin(sessionId, turnCtx(1, 1000), { text: "你好" });
    domain.writer.acpUpdate(sessionId, msg("你好呀"), turnCtx(1, 1001));
    domain.writer.flush();
    const snapshot = await kit.procedure("timeline.open", {
      timelineId: sessionId,
    });
    expect(snapshot.status).toBe(200);
    expect(
      (snapshot.body as { items: { kind: string }[] }).items.map((i) => i.kind),
    ).toEqual(expect.arrayContaining(["turn", "user", "assistant"]));
    const list = (
      await open.core.call(
        "GET",
        `/api/workspaces/${open.workspaceId}/sessions`,
      )
    ).body as {
      sessionId: string;
      activity?: { phase: string };
      timelineSeq?: number;
    }[];
    const row = list.find((r) => r.sessionId === sessionId);
    expect(row?.timelineSeq).toBeGreaterThan(0);
    expect(row?.activity?.phase).toBeDefined();
    expect(
      JSON.stringify(
        (await open.core.call("GET", `/api/acp/sessions/${sessionId}/log`))
          .body,
      ),
    ).toBe(logBefore);
  });
});
