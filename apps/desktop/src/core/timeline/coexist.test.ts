import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AcpCore, FAKE_AGENT, acpCore, until } from "../acp/fixture";
import type { WorkspaceEvent } from "../bus";
import { type Kit, startKit } from "../contract/parity-kit";
import { installContract } from "../http/rpc";
import { type TimelineDomain, install } from ".";

/**
 * 旧接口（`acp.log` 镜像读、`acp.update` / `acp.turn` 事件）与新接口（`timeline.*`）
 * 同时存在期间的行为（B10 之前两边都在）：ACP 会话（B3 起）同时写镜像 / 发
 * `acp.update`（旧）和写时间线 / 发 `timeline.*`（新）；两边读到的内容一致，各读各的、
 * 互不影响。没有会话写过的行 `timeline.*` 仍答 404，页面据此退回旧路径。
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
  });

  it("新接口同时有内容：timeline.open 有回合、用户消息与助手回复，会话列表带 activity", async () => {
    domain.writer.flush();
    const snapshot = await kit.procedure("timeline.open", {
      timelineId: sessionId,
    });
    expect(snapshot.status).toBe(200);
    const items = (
      snapshot.body as { items: { kind: string; text?: string }[] }
    ).items;
    expect(items.map((i) => i.kind)).toEqual(
      expect.arrayContaining(["turn", "user", "assistant"]),
    );
    expect(items.find((i) => i.kind === "user")?.text).toBe("你好");
    expect(seen.some((e) => e.type === "timeline.delta")).toBe(true);
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
    expect(row?.activity?.phase).toBe("idle");
  });

  it("没有会话写过的行：timeline.open 答 404", async () => {
    const answer = await kit.procedure("timeline.open", {
      timelineId: "00000000-0000-4000-8000-000000000000",
    });
    expect(answer.status).toBe(404);
  });

  it("读时间线不改变 acp.log", async () => {
    const before = JSON.stringify(
      (await open.core.call("GET", `/api/acp/sessions/${sessionId}/log`)).body,
    );
    await kit.procedure("timeline.open", { timelineId: sessionId });
    expect(
      JSON.stringify(
        (await open.core.call("GET", `/api/acp/sessions/${sessionId}/log`))
          .body,
      ),
    ).toBe(before);
  });
});
