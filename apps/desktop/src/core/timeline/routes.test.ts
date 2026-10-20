import { createBoard } from "../canvas/boards";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  workspaceEventSchema,
  timelineActivityEventSchema,
} from "@armadra/shared";

import type { WorkspaceEvent } from "../bus";
import { installContract } from "../http/rpc";
import { type Kit, startKit } from "../contract/parity-kit";
import { EPHEMERAL_EVENTS } from "../events/stream";
import { install as installEvents } from "../events";
import { watermark } from "../events/outbox";
import { install as installCanvas } from "../canvas/routes";
import { install as installWorkspaces } from "../workspaces/routes";
import { type Fixture, fixture } from "../workspaces/fixture";
import { type TimelineDomain, TimelineDomain as Domain, install } from ".";
import { MAX_RPC_BLOB_BYTES } from "./routes";
import {
  msg,
  seedSession,
  think,
  toolCall,
  toolUpdate,
  turnCtx,
} from "./testing";

/**
 * `timeline.*` 的 procedure 与 blob 的 HTTP 路径，对着真库、真路由和真契约（出参按
 * 契约校验）。授权的各种身份在 `contract/parity-timeline.test.ts`。
 */

let core: Fixture;
let kit: Kit;
let domain: TimelineDomain;
let workspaceId: string;
let boardId: string;
let events: WorkspaceEvent[];

beforeAll(async () => {
  core = fixture([
    installEvents,
    installWorkspaces,
    installCanvas,
    (context) => {
      domain = install(context) as TimelineDomain;
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  kit = await startKit(core.server, () => undefined);
  workspaceId = (
    (await core.call("GET", "/api/workspaces")).body as { id: string }[]
  )[0]!.id;
  boardId = createBoard(core.database, workspaceId, "B").id;
  events = [];
  core.bus.on("workspace.event", ({ event }) => events.push(event));
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

let counter = 0;
/** 一条有内容的时间线：一个回合（思考、工具、文本、用量），并刷写到库。 */
function populated(): string {
  const id = `sess-${++counter}`;
  seedSession(core.database, boardId, workspaceId, id, `node-${counter}`);
  domain.open({ timelineId: id, workspaceId, nodeId: `node-${counter}` });
  for (let turn = 1; turn <= 4; turn++) {
    const ctx = turnCtx(turn, 1_000 * turn);
    domain.writer.turnBegin(id, ctx, { text: `问题 ${turn}` });
    domain.writer.acpUpdate(id, think("想"), ctx);
    domain.writer.acpUpdate(id, toolCall(`c${turn}`), ctx);
    domain.writer.acpUpdate(
      id,
      toolUpdate(`c${turn}`, { status: "completed" }),
      ctx,
    );
    domain.writer.acpUpdate(id, msg(`答 ${turn}`), ctx);
    domain.writer.acpUpdate(
      id,
      { sessionUpdate: "usage_update", used: turn, size: 100 },
      ctx,
    );
    domain.writer.turnEnd(id, ctx, { stopReason: "end_turn" });
  }
  domain.writer.flush();
  return id;
}

describe("timeline.open / sync / page", () => {
  it("open：尾部 3 个回合、全部回合的索引、头部值与活动", async () => {
    const id = populated();
    const answer = await kit.procedure("timeline.open", { timelineId: id });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const body = answer.body as {
      headSeq: number;
      head: { usage?: { used: number } };
      turns: { turn: number; headText: string }[];
      items: { turn: number }[];
      activity?: { phase: string };
    };
    expect(body.turns.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
    expect(body.turns[3]?.headText).toBe("问题 4");
    expect(new Set(body.items.map((i) => i.turn))).toEqual(new Set([2, 3, 4]));
    expect(body.head.usage?.used).toBe(4);
    expect(body.headSeq).toBe(domain.store.get(id)?.headSeq);
    expect(body.activity?.phase).toBe("idle");
  });

  it("open 的 tailTurns 生效", async () => {
    const id = populated();
    const answer = await kit.procedure("timeline.open", {
      timelineId: id,
      tailTurns: 1,
    });
    const body = answer.body as { items: { turn: number }[] };
    expect(new Set(body.items.map((i) => i.turn))).toEqual(new Set([4]));
  });

  it("sync：after 之后的增量；after 等于 headSeq 是空；超过 headSeq 答 409 cursor_ahead", async () => {
    const id = populated();
    const head = domain.store.get(id)!.headSeq;
    const full = await kit.procedure("timeline.sync", {
      timelineId: id,
      after: 0,
    });
    expect((full.body as { items: unknown[] }).items.length).toBeGreaterThan(
      10,
    );
    const none = await kit.procedure("timeline.sync", {
      timelineId: id,
      after: head,
    });
    expect(none.body).toEqual({ headSeq: head, items: [] });
    const ahead = await kit.procedure("timeline.sync", {
      timelineId: id,
      after: head + 5,
    });
    expect(ahead.status).toBe(409);
    expect(ahead.body).toMatchObject({ code: "cursor_ahead" });
  });

  it("page：beforeTurn 之前的回合", async () => {
    const id = populated();
    const answer = await kit.procedure("timeline.page", {
      timelineId: id,
      beforeTurn: 3,
      turns: 5,
    });
    const items = (answer.body as { items: { turn: number }[] }).items;
    expect(new Set(items.map((i) => i.turn))).toEqual(new Set([1, 2]));
  });

  it("没有时间线的会话答 404 not_found（页面据此退回旧路径）", async () => {
    for (const [name, input] of [
      ["timeline.open", { timelineId: "nope" }],
      ["timeline.sync", { timelineId: "nope", after: 0 }],
      ["timeline.page", { timelineId: "nope", beforeTurn: 1 }],
      ["timeline.blob", { timelineId: "nope", blobId: "x" }],
    ] as const) {
      const answer = await kit.procedure(name, input);
      expect(answer.status, name).toBe(404);
      expect(answer.body, name).toMatchObject({ code: "not_found" });
    }
  });

  it("入参形状错由契约先答 400", async () => {
    const answer = await kit.procedure("timeline.sync", {
      timelineId: "x",
      after: -1,
    });
    expect(answer.status).toBe(400);
  });
});

describe("blob", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");

  function withBlob(
    mime: string,
    bytes: Buffer,
  ): { id: string; blobId: string } {
    const id = populated();
    const stored = domain.blobs.store(id, mime, bytes.toString("base64"));
    return { id, blobId: stored!.blobId };
  }

  it("procedure 返回 base64；HTTP 路径返回原始字节，带内容寻址的缓存头与沙箱", async () => {
    const { id, blobId } = withBlob("image/png", png);
    const rpc = await kit.procedure("timeline.blob", {
      timelineId: id,
      blobId,
    });
    expect(rpc.body).toEqual({
      mimeType: "image/png",
      bytes: png.length,
      data: png.toString("base64"),
    });
    const response = await fetch(
      `${kit.base}/api/timelines/${id}/blobs/${blobId}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
  });

  it("不是图片 / 音频的类型（SVG、HTML）一律当不透明字节下载，不会作为文档运行", async () => {
    const { id, blobId } = withBlob(
      "image/svg+xml",
      Buffer.from("<svg onload=alert(1)/>"),
    );
    const response = await fetch(
      `${kit.base}/api/timelines/${id}/blobs/${blobId}`,
    );
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });

  it("别的时间线的 blob、不存在的 blob、乱写的 id 都是 404", async () => {
    const mine = withBlob("image/png", png);
    const other = populated();
    for (const [timelineId, blobId] of [
      [other, mine.blobId],
      [mine.id, "0".repeat(64)],
      [mine.id, "..%2F..%2Fetc%2Fpasswd"],
    ] as const) {
      const response = await fetch(
        `${kit.base}/api/timelines/${timelineId}/blobs/${blobId}`,
      );
      expect(response.status, `${timelineId} ${blobId}`).toBe(404);
    }
    const rpc = await kit.procedure("timeline.blob", {
      timelineId: other,
      blobId: mine.blobId,
    });
    expect(rpc.status).toBe(404);
  });

  it("超过一帧能装下的 blob：procedure 拒绝并指路，HTTP 路径照常给", async () => {
    const big = Buffer.alloc(MAX_RPC_BLOB_BYTES + 10, 7);
    const { id, blobId } = withBlob("image/png", big);
    const rpc = await kit.procedure("timeline.blob", {
      timelineId: id,
      blobId,
    });
    expect(rpc.status).toBe(400);
    const response = await fetch(
      `${kit.base}/api/timelines/${id}/blobs/${blobId}`,
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(big.length);
  });
});

describe("事件", () => {
  it("timeline.delta / timeline.activity 是短时事件，形状通过 workspaceEventSchema", () => {
    expect(EPHEMERAL_EVENTS.has("timeline.delta")).toBe(true);
    expect(EPHEMERAL_EVENTS.has("timeline.activity")).toBe(true);
    const id = populated();
    domain.activity.prompt(id, "tx");
    const deltas = events.filter(
      (e) => e.type === "timeline.delta" && e.timelineId === id,
    );
    const activities = events.filter(
      (e) => e.type === "timeline.activity" && e.timelineId === id,
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(activities.length).toBeGreaterThan(0);
    for (const event of [...deltas, ...activities]) {
      expect(workspaceEventSchema.safeParse(event).success).toBe(true);
    }
    const last = activities[activities.length - 1] as unknown as {
      activity: unknown;
      timelineId: string;
      nodeId: string;
    };
    expect(timelineActivityEventSchema.safeParse(last).success).toBe(true);
  });

  it("增量帧不进 outbox，也不占水位", () => {
    const before = watermark(core.database).watermark;
    populated();
    expect(watermark(core.database).watermark).toBe(before);
    // 对照：一个普通事件会占一个位置。
    core.bus.emit("workspace.event", {
      workspaceId,
      event: { type: "board.changed", boardId, updatedAt: "now" },
    });
    expect(watermark(core.database).watermark).toBe(before + 1);
  });
});

describe("重启与清理", () => {
  it("recoverInterrupted：上一个进程留下的 ACP 回合收尾为 cancelled，挂着的审批变 cancelled", () => {
    const id = `sess-r${++counter}`;
    seedSession(core.database, boardId, workspaceId, id, `node-r${counter}`);
    domain.open({ timelineId: id, workspaceId, nodeId: `node-r${counter}` });
    const ctx = turnCtx(1, 5_000);
    domain.writer.turnBegin(id, ctx, { text: "q" });
    domain.writer.acpUpdate(id, toolCall("c1"), ctx);
    domain.writer.acpUpdate(id, msg("说到一半"), ctx);
    domain.writer.put(id, {
      id: "ap:p1",
      turn: 1,
      ord: 40,
      rev: 0,
      source: "acp",
      at: 1,
      gen: 1,
      kind: "approval",
      pendingId: "p1",
      protocol: "acp",
      options: [],
      state: "pending",
    });
    domain.writer.flush();
    // 重启：新的域对象、同一个库，没有任何内存状态。
    const revived = new Domain(core);
    expect(revived.recoverInterrupted()).toBe(1);
    const items = revived.store.tailItems(id, 5);
    const byKind = (kind: string) => items.filter((i) => i.kind === kind);
    expect(byKind("approval")[0]).toMatchObject({ state: "cancelled" });
    expect(byKind("tool")[0]).toMatchObject({ status: "cancelled" });
    expect(byKind("assistant")[0]).toMatchObject({ streaming: false });
    expect(byKind("turn")[0]).toMatchObject({ stopReason: "cancelled" });
    expect((byKind("turn")[0] as { endedAt?: number }).endedAt).toBeGreaterThan(
      0,
    );
    // 收尾是幂等的。
    expect(new Domain(core).recoverInterrupted()).toBe(0);
    // 活动重建：没人登记过，按会话行补 idle（行是 running）。
    expect(revived.activityOf(id)?.phase).toBe("idle");
    revived.close();
  });

  it("活动重建：休眠 / 已退出的会话行补 sleeping / exited；没有时间线的会话没有活动", () => {
    const id = populated();
    expect(domain.activityOf(id, "sleeping")?.phase).toBe("idle"); // 状态机里还有记录，以它为准
    const fresh = new Domain(core);
    expect(fresh.activityOf(id, "sleeping")?.phase).toBe("sleeping");
    expect(fresh.activityOf(id, "gone")?.phase).toBe("exited");
    expect(fresh.activityOf("nope")).toBeUndefined();
    expect(fresh.summaryOf(id, true)).toMatchObject({
      activity: { phase: "idle" },
      timelineSeq: domain.store.get(id)!.headSeq,
    });
    expect(fresh.summaryOf(id, false)?.activity.phase).toBe("exited");
    expect(fresh.summaryOf("nope", true)).toBeUndefined();
    fresh.close();
  });

  it("remove 连条目与 blob 字节一起删；pruneOrphans 只清节点已不在库里的旧时间线", () => {
    const id = populated();
    const stored = domain.blobs.store(
      id,
      "image/png",
      Buffer.from("x").toString("base64"),
    )!;
    domain.remove(id);
    expect(domain.store.get(id)).toBeUndefined();
    expect(domain.blobs.read(id, stored.blobId)).toBeUndefined();

    const kept = populated(); // 节点在库里
    const orphan = `orph-${++counter}`;
    domain.open({ timelineId: orphan, workspaceId, nodeId: "gone-node" });
    expect(domain.pruneOrphans(Date.now())).toBe(0); // 太新，宽限期内
    expect(domain.pruneOrphans(Date.now() + 25 * 60 * 60 * 1000)).toBe(1);
    expect(domain.store.get(orphan)).toBeUndefined();
    expect(domain.store.get(kept)).toBeDefined();
  });
});
