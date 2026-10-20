import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";

import { createBoard } from "../canvas/boards";
import { install as installCanvas } from "../canvas/routes";
import { install as installEvents } from "../events";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import type { AuthorizationSubject } from "../identity/authorize";
import { installRouteGuard, resetRouteGuard } from "../identity/gate";
import { type ShareRole, roleScopes } from "../identity/roles";
import { createRouteGuard } from "../identity/route-access";
import { type Scope, permits, scope } from "../identity/scopes";
import { type TimelineDomain, install } from "../timeline";
import { msg, seedSession, turnCtx } from "../timeline/testing";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type Kit, startKit } from "./parity-kit";

/**
 * timeline 域的授权与两张表（契约 §82）。
 *
 * 时间线以会话行 id 为键，没有旧路径：成员经 procedure（`rpc:timeline.*`）与 blob 的
 * HTTP 路径被同一道路由门按**会话行查出画布**再判 `terminal:read`——看终端的人看得到，
 * 别的画布上的人与陌生人看不到，只被授予一条会话的人看不到别的会话。
 */

let core: Fixture;
let kit: Kit;
let domain: TimelineDomain;
let w1: string;
let w2: string;
let blobId: string;

const GRANTS: Record<string, Record<"w1" | "w2", ShareRole | undefined>> = {
  driver: { w1: "driver", w2: undefined },
  operator: { w1: "operator", w2: undefined },
  editor: { w1: "editor", w2: undefined },
  viewer: { w1: "viewer", w2: undefined },
  outsider: { w1: undefined, w2: "driver" },
  stranger: { w1: undefined, w2: undefined },
};

function granted(name: string): Scope[] {
  if (name === "only-s1") return [scope("terminal:read", w1, "", "s1")];
  const grants = GRANTS[name];
  if (grants === undefined) return [];
  return [
    ...(grants.w1 === undefined ? [] : roleScopes(grants.w1, w1)),
    ...(grants.w2 === undefined ? [] : roleScopes(grants.w2, w2)),
  ];
}

function subject(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

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
  kit = await startKit(core.server, (who) => ({ subject: subject(who) }));
  w1 = (
    (await core.call("GET", "/api/workspaces")).body as { id: string }[]
  )[0]!.id;
  const otherRoot = join(core.directory, "other");
  mkdirSync(otherRoot);
  const created = await core.call("POST", "/api/workspaces", {
    name: "other",
    rootPath: otherRoot,
  });
  expect(created.status).toBe(200);
  w2 = (created.body as { id: string }).id;
  const b1 = createBoard(core.database, w1, "B1").id;
  const b2 = createBoard(core.database, w2, "B2").id;
  seedSession(core.database, b1, w1, "s1", "n1");
  seedSession(core.database, b1, w1, "s1b", "n1b");
  seedSession(core.database, b2, w2, "s2", "n2");
  for (const [id, workspaceId, nodeId] of [
    ["s1", w1, "n1"],
    ["s1b", w1, "n1b"],
    ["s2", w2, "n2"],
  ] as const) {
    domain.open({ timelineId: id, workspaceId, nodeId });
    domain.writer.turnBegin(id, turnCtx(1, 1000), { text: "q" });
    domain.writer.acpUpdate(id, msg("a"), turnCtx(1, 1001));
    domain.writer.flush();
  }
  blobId = domain.blobs.store(
    "s1",
    "image/png",
    Buffer.from("png").toString("base64"),
  )!.blobId;
  installRouteGuard(
    createRouteGuard({
      database: core.database,
      permits: (who, required) =>
        permits([...who.scopes, ...granted(who.principalId)], required),
      effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
    }),
  );
});

afterAll(async () => {
  resetRouteGuard();
  await core.server.close();
  core.close();
});

const FORBIDDEN = { code: "forbidden", message: "没有这项权限" };

async function blobGet(as: string, timelineId: string, id = blobId) {
  const response = await fetch(
    `${kit.base}/api/timelines/${timelineId}/blobs/${id}`,
    { headers: { "x-parity-as": as } },
  );
  return response.status;
}

describe("授权：成员经 procedure 与 blob 路径被同一道路由门按会话行查画布", () => {
  it("看得了终端的人（viewer、editor、operator、driver）读得了四个动词", async () => {
    for (const as of ["viewer", "editor", "operator", "driver"]) {
      const open = await kit.procedure(
        "timeline.open",
        { timelineId: "s1" },
        as,
      );
      expect(open.status, `${as} open`).toBe(200);
      const sync = await kit.procedure(
        "timeline.sync",
        { timelineId: "s1", after: 0 },
        as,
      );
      expect(sync.status, `${as} sync`).toBe(200);
      const page = await kit.procedure(
        "timeline.page",
        { timelineId: "s1", beforeTurn: 9 },
        as,
      );
      expect(page.status, `${as} page`).toBe(200);
      const blob = await kit.procedure(
        "timeline.blob",
        { timelineId: "s1", blobId },
        as,
      );
      expect(blob.status, `${as} blob`).toBe(200);
      expect(await blobGet(as, "s1"), `${as} blob http`).toBe(200);
    }
  });

  it("别的画布上的人和陌生人读不到，四个动词与 blob 路径都 403", async () => {
    for (const as of ["outsider", "stranger"]) {
      for (const [name, input] of [
        ["timeline.open", { timelineId: "s1" }],
        ["timeline.sync", { timelineId: "s1", after: 0 }],
        ["timeline.page", { timelineId: "s1", beforeTurn: 9 }],
        ["timeline.blob", { timelineId: "s1", blobId }],
      ] as const) {
        const answer = await kit.procedure(name, input, as);
        expect(answer.status, `${as} ${name}`).toBe(403);
        expect(answer.body, `${as} ${name}`).toEqual(FORBIDDEN);
      }
      expect(await blobGet(as, "s1"), `${as} blob http`).toBe(403);
    }
  });

  it("不跨工作空间：w1 上的 driver 读不到 w2 的会话，w2 上的人读得到自己的", async () => {
    const denied = await kit.procedure(
      "timeline.open",
      { timelineId: "s2" },
      "driver",
    );
    expect(denied.status).toBe(403);
    const own = await kit.procedure(
      "timeline.open",
      { timelineId: "s2" },
      "outsider",
    );
    expect(own.status).toBe(200);
  });

  it("不存在的会话对成员也是 403，不泄露哪些 id 存在", async () => {
    const answer = await kit.procedure(
      "timeline.open",
      { timelineId: "nope" },
      "viewer",
    );
    expect(answer.status).toBe(403);
    expect(await blobGet("viewer", "nope")).toBe(403);
  });

  it("只被授予一条会话的人读得了那一条，读不到同一画布上的别的会话", async () => {
    const own = await kit.procedure(
      "timeline.open",
      { timelineId: "s1" },
      "only-s1",
    );
    expect(own.status).toBe(200);
    expect(await blobGet("only-s1", "s1")).toBe(200);
    const other = await kit.procedure(
      "timeline.open",
      { timelineId: "s1b" },
      "only-s1",
    );
    expect(other.status).toBe(403);
  });

  it("本机壳（没有请求主体）不受路由门限制", async () => {
    const response = await fetch(
      `${kit.base}/api/timelines/s1/blobs/${blobId}`,
    );
    expect(response.status).toBe(200);
  });
});

describe("契约与 core 的两张表（timeline）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("timeline."),
  );

  it("4 条 procedure 都在契约里、都实现了，权限是 terminal:read", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "timeline.blob",
      "timeline.open",
      "timeline.page",
      "timeline.sync",
    ]);
    for (const entry of entries) {
      expect(entry.meta.scope, entry.name).toBe("terminal:read");
      expect(entry.meta.since, entry.name).toBe("1.48");
    }
  });

  it("blob 的 HTTP 路径在路由表里并有人认领，权限与 procedure 同一档", () => {
    const path = "/api/timelines/{timelineId}/blobs/{blobId}";
    const found = core.server.router.match(path);
    expect(found?.entry.methods).toContain("GET");
    expect(core.server.router.claimed("GET", found?.entry.path as string)).toBe(
      true,
    );
    expect(routeScope("GET", path)?.permission).toBe("terminal:read");
  });
});
