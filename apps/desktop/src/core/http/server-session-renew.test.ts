import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventBus } from "../bus";
import { openDatabase } from "../db/open";
import { installRouteGuard, resetRouteGuard, runAs } from "../identity/gate";
import { allScopes } from "../identity/scopes";
import { SAAS_SESSION_TTL_MS, IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { sessionIdentity } from "../identity/transport";
import type { CorePlatform } from "../platform";
import { tempDir } from "../testing/temp-dir";
import { CLOSE_ACCESS_EXPIRED, CoreServer } from "./server";

/**
 * 限寿会话（SaaS 来源，#484）在一小时边界上：带新断言续同一会话时会话 id 不变，既有长连接
 * 在访问令牌到期复核时跟得上（不被 4401 关）；新建会话（旧会话到期）则会被关——这是续同一会话
 * 存在的理由。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const ORIGIN = "http://127.0.0.1:1420";
const INSTANCE = "0123456789abcdef0123456789abcdef";
const CHANNEL = "c".repeat(32);
const MIN = 60_000;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  resetRouteGuard();
});

function world() {
  const opened = openDatabase({
    file: join(tempDir("armadra-renew-"), "canvas.db"),
    migrationsDir,
  });
  cleanup.push(opened.close);
  let offset = 0;
  const now = () => Date.now() + offset;
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE, now);
  const hostId = store.hostId();
  const ticket = service.issueBootstrap({
    hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "本机",
    scopes: allScopes(),
  });
  const principalId = service.consumeBootstrap({
    ticket: ticket.ticket,
    hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
  }).principal.principalId;
  const open = () =>
    service.openSession({
      principalId,
      hostId,
      origin: ORIGIN,
      deviceName: "云端设备",
      method: "cloud",
      channelDeviceId: CHANNEL,
      bounded: { ttlMs: SAAS_SESSION_TTL_MS },
    });
  return {
    service,
    hostId,
    principalId,
    open,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

async function stream(
  w: ReturnType<typeof world>,
  credentials: ReturnType<ReturnType<typeof world>["open"]>,
) {
  const log = { error() {}, warn() {}, info() {}, debug() {} };
  const core = new CoreServer({
    platform: { log } as unknown as CorePlatform,
    bus: new EventBus(),
    version: "test",
  });
  core.stream("/api/terminals/{sessionId}/ws", (connection) => {
    connection.on("message", () => {});
  });
  const identity = {
    ...sessionIdentity(w.service, w.hostId, credentials.principal, ORIGIN),
    accessExpiresAtMs: Date.now() + 300,
  };
  const delegate = core.createListener();
  const front = createServer();
  front.on("upgrade", (request, socket, head) => {
    runAs(identity, () => delegate.emit("upgrade", request, socket, head));
  });
  await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
  cleanup.push(
    () => new Promise<void>((done) => front.close(() => done())),
    () => core.close(),
  );
  installRouteGuard(() => ({ allowed: true }));
  const port = (front.address() as AddressInfo).port;
  return new Promise<{ socket: WebSocket; code: Promise<number> }>(
    (done, failed) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminals/s1/ws`,
        { origin: `http://127.0.0.1:${port}` },
      );
      const code = new Promise<number>((settle) =>
        socket.once("close", (value) => settle(value)),
      );
      socket.once("open", () => done({ socket, code }));
      socket.once("error", failed);
    },
  );
}

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("一小时边界上的长连接", () => {
  it("带新断言续同一会话：跨过 60 分钟，既有流不被 4401 关", async () => {
    const w = world();
    const first = w.open();
    const { socket } = await stream(w, first);
    w.advance(59 * MIN);
    const continued = w.service.continueBounded({
      refreshToken: first.refreshToken,
      hostId: w.hostId,
      origin: ORIGIN,
      principalId: w.principalId,
      channelDeviceId: CHANNEL,
      ttlMs: SAAS_SESSION_TTL_MS,
    });
    expect(continued?.principal.sessionId).toBe(first.principal.sessionId);
    w.advance(2 * MIN);
    await settle(600);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("没续（旧会话到期）：流以 4401 关", async () => {
    const w = world();
    const { code } = await stream(w, w.open());
    w.advance(61 * MIN);
    expect(await code).toBe(CLOSE_ACCESS_EXPIRED);
  });
});
