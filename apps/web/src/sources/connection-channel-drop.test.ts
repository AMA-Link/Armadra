import { describe, expect, it, vi } from "vitest";

import { createRemoteConnection } from "./connection";
import type {
  CredentialProvider,
  SourceAccess,
  SourceDescriptor,
} from "./types";

/**
 * 经中转的源，端到端通道关了之后（#387）：访问里的 `fetch` / `WebSocket` 绑在那一条
 * 通道上，连接要丢掉这份访问、重新取；对端不在线落到 `waitingForSource`，回来之后
 * 自动恢复。
 */

const B = "b".repeat(32);
const RELAY_B = "https://relay.example/s/b";

const descriptor: SourceDescriptor = {
  sourceId: B,
  kind: "relayed",
  label: "b",
  baseUrl: "",
  relayOrigin: "https://relay.example",
  cloudIssuer: "https://relay.example",
  fingerprint: "",
  orderIndex: 1,
};

const hello = {
  protocol: { major: 1, minor: 3 },
  procedures: ["system.hello"],
  capabilities: [],
  heartbeatMs: 25_000,
  maxFrameBytes: 1 << 20,
  sessionExpiresAtMs: null,
  instanceId: "i",
  sourceId: B,
  version: "0.0.0",
};

/** 一条假的通道：`close()` 叫监听者（已关的立刻叫），关了之后 `fetch` 抛 TypeError。 */
function fakeChannel() {
  let closed = false;
  const listeners = new Set<() => void>();
  const fetch: typeof globalThis.fetch = async (input) => {
    if (closed) throw new TypeError("channel closed");
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/rpc/system/hello"))
      return new Response(JSON.stringify({ json: hello }));
    return new Response(JSON.stringify({ ok: true }));
  };
  const access = (token: string): SourceAccess => ({
    accessToken: token,
    expiresAtMs: 0,
    httpBase: RELAY_B,
    wsBase: RELAY_B.replace(/^https/, "wss"),
    relayToken: "RT",
    e2e: {
      fetch,
      WebSocket: class {} as unknown as typeof WebSocket,
      onClose(listener) {
        if (closed) {
          queueMicrotask(listener);
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    access,
    close() {
      closed = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

function setup(clock = { at: 0 }) {
  let channel = fakeChannel();
  let peer: "online" | "offline" = "online";
  let issued = 0;
  const provider: CredentialProvider = {
    getAccess: vi.fn(async () => {
      if (peer === "offline")
        throw Object.assign(new Error("offline"), { code: "source_offline" });
      channel = fakeChannel();
      issued += 1;
      return channel.access(`b-${issued}`);
    }),
    refresh: vi.fn(async () => {
      throw Object.assign(new Error("no"), { code: "source_unauthorized" });
    }),
    invalidate: vi.fn(),
  };
  const connection = createRemoteConnection(descriptor, {
    provider,
    environment: null,
    now: () => clock.at,
  });
  return {
    connection,
    provider,
    clock,
    get channel() {
      return channel;
    },
    setPeer: (next: "online" | "offline") => {
      peer = next;
    },
  };
}

describe("通道关闭后的经中转源", () => {
  it("对端下线：丢掉访问、不再显示就绪，落到 waitingForSource；回来之后 connect 恢复", async () => {
    const world = setup();
    const { connection, provider } = world;
    await connection.connect();
    expect(connection.status).toMatchObject({ state: "ready", via: "relayed" });
    const statuses: string[] = [];
    connection.subscribe(() => statuses.push(connection.status.state));

    world.setPeer("offline");
    world.channel.close();
    await flush();
    await flush();

    expect(provider.invalidate).toHaveBeenCalledWith(B);
    expect(connection.status).toMatchObject({
      state: "waitingForSource",
      lastError: { code: "source_offline" },
    });
    expect(statuses).not.toContain("ready");

    world.setPeer("online");
    await connection.connect();
    expect(connection.status).toMatchObject({ state: "ready", via: "relayed" });
    expect(connection.hello?.sourceId).toBe(B);
  });

  it("对端还在：通道关了就换一份新访问，回到就绪，请求走新通道", async () => {
    const world = setup();
    const { connection } = world;
    await connection.connect();
    const first = world.channel;
    first.close();
    await flush();
    await flush();
    expect(connection.status.state).toBe("ready");
    expect(world.channel).not.toBe(first);
    const response = await connection.request("/api/x");
    expect(response.ok).toBe(true);
    // 旧通道上不再留监听。
    expect(first.listeners).toBe(0);
  });

  it("断开之后旧通道的关闭不再有影响", async () => {
    const world = setup();
    const { connection, provider } = world;
    await connection.connect();
    const first = world.channel;
    connection.disconnect();
    const calls = vi.mocked(provider.getAccess).mock.calls.length;
    first.close();
    await flush();
    expect(vi.mocked(provider.getAccess).mock.calls.length).toBe(calls);
    expect(connection.status.state).toBe("idle");
  });

  it("刚建好的通道又立刻关：不在原地循环，状态 offline，留给流的重连", async () => {
    const world = setup();
    const { connection, provider } = world;
    await connection.connect();
    world.channel.close();
    await flush();
    await flush();
    expect(connection.status.state).toBe("ready");
    const calls = vi.mocked(provider.getAccess).mock.calls.length;
    // 新通道也立刻关（时钟没动）。
    world.channel.close();
    await flush();
    await flush();
    expect(vi.mocked(provider.getAccess).mock.calls.length).toBe(calls);
    expect(connection.status.state).toBe("offline");
  });
});
