import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { EventBus, type WorkspaceEvent } from "../bus";
import { openFreshDatabase } from "../db/fresh.fixture";
import { CoreServer } from "../http/server";
import type { AuthorizationSubject } from "../identity/authorize";
import {
  type RequestIdentity,
  installRouteGuard,
  resetRouteGuard,
  runAs,
} from "../identity/gate";
import { scope } from "../identity/scopes";
import type { CoreContext } from "../main";
import type { CorePlatform } from "../platform";
import { tempDir } from "../testing/temp-dir";
import { install } from "./index";
import { openWorkspaceEvents } from "./procedure";
import { WorkspaceEventStream } from "./stream";

/**
 * 「背书通知只给 owner」的两处接线（契约 §81.1）：控制面订阅 `workspaces.events` 与
 * `WS /api/workspaces/{id}/events` 都按订阅者的请求身份判。成员收不到 `devices.endorsed`，
 * 别的事件照收；owner 两种都收。
 */

const here = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = "ws-1";
const MEMBER: AuthorizationSubject = {
  principalId: "p-member",
  kind: "member",
  scopes: [scope("events:read", WORKSPACE)],
};
const OWNER: AuthorizationSubject = {
  principalId: "p-owner",
  kind: "owner",
  scopes: [],
};
const ENDORSED = {
  type: "devices.endorsed",
  deviceId: "d",
  principalId: "p",
  endorserDeviceId: "e",
  endorserPrincipalId: "o",
} as WorkspaceEvent;
const CHANGED = {
  type: "devices.changed",
  deviceId: "d",
} as WorkspaceEvent;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  resetRouteGuard();
});

function database() {
  const opened = openFreshDatabase(
    join(tempDir("armadra-owner-only-"), "canvas.db"),
    resolve(here, "../db/migrations"),
  );
  cleanup.push(() => opened.close());
  opened.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      WORKSPACE,
      WORKSPACE,
      "/tmp/ws-1",
      "2026-10-29T00:00:00Z",
      "2026-10-29T00:00:00Z",
    );
  return opened.database;
}

/** 一条订阅在发完一帧背书、一帧设备变化之后收到的业务事件类型。 */
async function viaProcedure(subject: AuthorizationSubject): Promise<string[]> {
  const stream = new WorkspaceEventStream();
  const abort = new AbortController();
  const iterator = openWorkspaceEvents(
    stream,
    database(),
    { workspaceId: WORKSPACE },
    { identity: { subject }, signal: abort.signal },
  );
  const first = await iterator.next();
  expect((first.value as { type: string }).type).toBe("cursor");
  stream.publish(WORKSPACE, ENDORSED);
  stream.publish(WORKSPACE, CHANGED);
  const types: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<undefined>((done) => setTimeout(() => done(undefined), 50)),
    ]);
    if (next === undefined || next.done === true) break;
    types.push((next.value as { type: string }).type);
  }
  abort.abort();
  return types;
}

async function viaSocket(identity: RequestIdentity): Promise<string[]> {
  const log = { error() {}, warn() {}, info() {}, debug() {} };
  const bus = new EventBus();
  const server = new CoreServer({
    platform: { log } as unknown as CorePlatform,
    bus,
    version: "test",
  });
  install({
    bus,
    server,
    log,
    db: { database: database() },
  } as unknown as CoreContext);
  installRouteGuard(() => ({ allowed: true }));
  const delegate = server.createListener();
  const front = createServer();
  front.on("upgrade", (request, socket, head) => {
    runAs(identity, () => delegate.emit("upgrade", request, socket, head));
  });
  await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
  cleanup.push(
    () => new Promise<void>((done) => front.close(() => done())),
    () => server.close(),
  );
  const port = (front.address() as AddressInfo).port;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/workspaces/${WORKSPACE}/events`,
    { origin: `http://127.0.0.1:${port}` },
  );
  cleanup.push(() => socket.close());
  const types: string[] = [];
  socket.on("message", (data: Buffer) =>
    types.push((JSON.parse(data.toString("utf8")) as { type: string }).type),
  );
  await new Promise((done, failed) => {
    socket.once("open", done);
    socket.once("error", failed);
  });
  bus.emit("workspace.event", { workspaceId: WORKSPACE, event: ENDORSED });
  bus.emit("workspace.event", { workspaceId: WORKSPACE, event: CHANGED });
  await new Promise((done) => setTimeout(done, 100));
  return types;
}

describe("devices.endorsed 只扇给 owner 的订阅（契约 §81.1）", () => {
  it("workspaces.events：成员收不到背书，别的事件照收；owner 两种都收", async () => {
    expect(await viaProcedure(MEMBER)).toEqual(["devices.changed"]);
    expect(await viaProcedure(OWNER)).toEqual([
      "devices.endorsed",
      "devices.changed",
    ]);
  });

  it("WebSocket 订阅：成员收不到背书，别的事件照收；owner 两种都收", async () => {
    expect(await viaSocket({ subject: MEMBER })).toEqual(["devices.changed"]);
    expect(await viaSocket({ subject: OWNER })).toEqual([
      "devices.endorsed",
      "devices.changed",
    ]);
  });
});
