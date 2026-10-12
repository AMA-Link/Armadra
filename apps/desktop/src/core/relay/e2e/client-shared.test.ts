import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ed25519SignerFromSeed } from "@armadra/platform-protocol/e2e";
import {
  E2eChannelError,
  E2eClientChannel,
  channelFetch,
  channelWebSocket,
} from "@armadra/shared/e2e";

import { signAssertion } from "../../identity/cloud/fake.fixture";
import { install as installFiles } from "../../files/routes";
import { ISSUER, type RelayCore, relayCore, until } from "../core.fixture";
import { e2eDevices } from "./peer";

/**
 * 页面那份客户端（`@armadra/shared/e2e`：通道、`fetch`、`WebSocket`）对真 core：经假中继
 * 的端到端边缘（`/s/<sourceId>/_relay/e2e`）连上，走完设备核对、会话、HTTP、
 * WebSocket 与大文件流式；中继那一侧抓到的字节里找不到任何明文。
 */

const WORKSPACE = "ws-shared";
const FILE = "secret.bin";
const MARKER = "armadra-plaintext-marker-7f3c";

let world: RelayCore;
let sourceId: string;

beforeEach(async () => {
  world = await relayCore({ domains: [(context) => installFiles(context)] });
  world.core.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      WORKSPACE,
      WORKSPACE,
      world.core.directory,
      "2026-10-12T00:00:00Z",
      "2026-10-12T00:00:00Z",
    );
  await world.register();
  await world.relay.nextTunnel(0);
  sourceId = world.store.hostId();
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
  const owner = world.store.transaction((tx) => tx.owner())!;
  await world.cloud.bind(
    owner.principalId,
    signAssertion({ aud: sourceId, nowMs: Date.now() }),
  );
});

afterEach(async () => {
  await world.close();
});

async function open(seed = 9, pinned?: Uint8Array) {
  return E2eClientChannel.open({
    url: world.relay.e2eUrl(sourceId),
    relayToken: "relay-token",
    sourceId,
    device: await ed25519SignerFromSeed(new Uint8Array(32).fill(seed)),
    platform: "browser",
    name: "Shared Client",
    pingIntervalMs: 0,
    ...(pinned === undefined ? {} : { pinned }),
  });
}

/** 页面眼里这台源的基址（中继给的；通道里只用它的路径）。 */
function httpBase(): string {
  return world.relay.url
    .replace(/\/t\/v1$/, `/s/${sourceId}`)
    .replace(/^ws/, "http");
}

function loginWith(fetcher: typeof fetch) {
  return fetcher(`${httpBase()}/api/identity/cloud/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assertion: signAssertion({ aud: sourceId, nowMs: Date.now() }),
    }),
  });
}

describe("页面客户端经端到端通道", () => {
  it("核对设备 → 换会话 → HTTP、WebSocket、10 MB 流式下载；中继抓不到明文", async () => {
    const blob = Buffer.concat([
      Buffer.from(MARKER),
      randomBytes(10 * 1024 * 1024),
    ]);
    writeFileSync(join(world.core.directory, FILE), blob);
    const channel = await open();
    expect(channel.accept.deviceStatus).toBe("pending");
    const fetcher = channelFetch(channel, { origin: ISSUER, base: httpBase() });
    const base = httpBase();

    const pending = await loginWith(fetcher);
    expect(pending.status).toBe(403);
    const pendingId = (
      (await pending.json()) as { details: { pendingId: string } }
    ).details.pendingId;
    e2eDevices()!.approve(pendingId, channel.sas);
    const login = await loginWith(fetcher);
    expect(login.status).toBe(200);
    const token = (
      (await login.json()) as { session: { native: { accessToken: string } } }
    ).session.native.accessToken;

    const listed = await fetcher(`${base}/api/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(WORKSPACE);

    // 10 MB 流式：按块读，字节与磁盘上的一致。
    const download = await fetcher(
      `${base}/api/workspaces/${WORKSPACE}/file-download?path=${FILE}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(download.status).toBe(200);
    const hash = createHash("sha256");
    let received = 0;
    const reader = download.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
    }
    expect(received).toBe(blob.length);
    expect(hash.digest("hex")).toBe(
      createHash("sha256").update(blob).digest("hex"),
    );

    // WebSocket：票在通道上签、在通道上兑。
    const ticket = await fetcher(`${base}/api/identity/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const { ticket: value } = (await ticket.json()) as { ticket: string };
    const Socket = channelWebSocket(channel, {
      origin: ISSUER,
      base: httpBase(),
    });
    const socket = new Socket(
      `${base.replace(/^http/, "ws")}/api/workspaces/${WORKSPACE}/events`,
      [`armadra-ticket.${value}`],
    );
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onclose = (event) => reject(new Error(`closed ${event.code}`));
    });
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    socket.close(1000);
    expect(await closed).toBe(1000);

    // 中继看到的：只有密文。令牌、路径、文件里的标记都不在里面。
    const seen = Buffer.concat(world.relay.edgeCapture);
    expect(seen.length).toBeGreaterThan(blob.length);
    for (const needle of [token, "/api/workspaces", MARKER, "Bearer", value])
      expect(seen.includes(Buffer.from(needle)), needle).toBe(false);
    // 线上字节两端一致：客户端的单元计数 = 边缘转发的字节。
    await until(
      () =>
        world.relay.edgeBytes.toSource === channel.counters.wireOut &&
        world.relay.edgeBytes.toClient === channel.counters.wireIn,
    );
    channel.close();
  }, 60_000);

  it("未信任的设备换不到会话；拒绝之后通道被断开", async () => {
    const channel = await open(4);
    const fetcher = channelFetch(channel, { origin: ISSUER, base: httpBase() });
    const pending = await loginWith(fetcher);
    expect(pending.status).toBe(403);
    const body = (await pending.json()) as {
      code: string;
      details: { pendingId: string };
    };
    expect(body.code).toBe("device_pending");
    const closed = new Promise<E2eChannelError>((resolve) =>
      channel.onClose(resolve),
    );
    e2eDevices()!.reject(body.details.pendingId);
    expect((await closed).code).toBe("closed");
  });

  it("钉住的不是这台：identity_mismatch，不发 m3", async () => {
    await expect(open(5, new Uint8Array(32).fill(1))).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("源不报 e2e 能力或不在线：unreachable", async () => {
    await expect(
      E2eClientChannel.open({
        url: world.relay.e2eUrl("f".repeat(32)),
        relayToken: "relay-token",
        sourceId: "f".repeat(32),
        device: await ed25519SignerFromSeed(new Uint8Array(32).fill(2)),
        platform: "browser",
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });
});
