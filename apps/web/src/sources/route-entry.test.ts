import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installLocalTransport,
  localSource,
  reconnectLocalTransport,
} from "../api/source";
import { CHANNEL_RETRY_MS, type EnteredRoute, enterRoute } from "./route-entry";
import { pickRoute } from "./routing";
import type {
  CredentialProvider,
  SourceAccess,
  SourceDescriptor,
} from "./types";

vi.mock("./routing", () => ({ pickRoute: vi.fn() }));
vi.mock("../api/identity", async (original) => ({
  ...(await original<typeof import("../api/identity")>()),
  fetchWsTicket: vi.fn(async () => "ticket"),
}));

/**
 * 装成本机源的经中继那一路（中继托管页面、手机，#571）：端到端通道关了之后，
 * 流不在已关的通道上重连；主机回来 `recover()` 换一条新通道，流在新通道上恢复。
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
  orderIndex: 0,
};

/** 每条流的底层 socket 开在哪条通道上。 */
let opened: string[] = [];
/** 接下来几个请求被 core 以会话失效拒掉（401）。 */
let refusals = 0;

/** 一条假的通道：`close()` 叫监听者（已关的立刻叫）。 */
function fakeChannel(name: string, expiresAtMs = 0) {
  let closed = false;
  const listeners = new Set<() => void>();
  const fetch = vi.fn(async () => {
    if (closed) throw new TypeError("channel closed");
    if (refusals > 0) {
      refusals -= 1;
      return new Response(JSON.stringify({ code: "unauthenticated" }), {
        status: 401,
      });
    }
    return new Response("{}");
  });
  class ChannelSocket extends EventTarget {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType: BinaryType = "blob";
    constructor(readonly url: string) {
      super();
      opened.push(name);
    }
    send() {}
    close() {}
  }
  const access: SourceAccess = {
    accessToken: name,
    expiresAtMs,
    httpBase: RELAY_B,
    wsBase: RELAY_B.replace(/^https/, "wss"),
    relayToken: "RT",
    e2e: {
      fetch: fetch as unknown as typeof globalThis.fetch,
      WebSocket: ChannelSocket as unknown as typeof WebSocket,
      onClose(listener) {
        if (closed) {
          listener();
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  return {
    access,
    fetch,
    close() {
      closed = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

let entered: EnteredRoute | null = null;

afterEach(() => {
  entered?.dispose();
  entered = null;
  installLocalTransport(null);
  opened = [];
  refusals = 0;
});

async function setup({ expiresAtMs = 0 } = {}) {
  const clock = { at: 1_000_000 };
  let channel = fakeChannel("c1", expiresAtMs);
  let peer: "online" | "offline" = "online";
  let issued = 1;
  let dropNext = false;
  /** 重取一份访问：主机不在就抛；在就开一条新通道。 */
  const issue = async () => {
    if (peer === "offline")
      throw Object.assign(new Error("offline"), { code: "source_offline" });
    issued += 1;
    channel = fakeChannel(`c${issued}`, expiresAtMs);
    // 新通道刚开好、还没交到手里就又关了（对端又掉了）。
    if (dropNext) {
      dropNext = false;
      channel.close();
    }
    return channel.access;
  };
  const provider: CredentialProvider = {
    getAccess: vi.fn(issue),
    refresh: vi.fn(issue),
    invalidate: vi.fn(),
  };
  vi.mocked(pickRoute).mockResolvedValue({
    via: "relayed",
    access: channel.access,
  });
  entered = await enterRoute({
    descriptor,
    provider,
    useRoute: () => undefined,
    restore: async () => true,
    now: () => clock.at,
  });
  return {
    entered,
    provider,
    clock,
    get channel() {
      return channel;
    },
    setPeer(next: "online" | "offline") {
      peer = next;
    },
    dropNextChannel() {
      dropNext = true;
    },
  };
}

/** 像流（重）连那样开一条：答它是开上了底层 socket 还是在换票时就收了尾。 */
function stream(): Promise<"opened" | "closed"> {
  const before = opened.length;
  const socket = new localSource.WebSocket(`${RELAY_B}/api/ws`);
  return new Promise((done) => {
    socket.addEventListener("close", () => done("closed"));
    void vi
      .waitFor(() => expect(opened.length).toBeGreaterThan(before))
      .then(
        () => done("opened"),
        () => undefined,
      );
  });
}

describe("经中继装成本机源：端到端通道关了之后", () => {
  it("通道关着、主机不在：流不在旧通道上重连，冷却内不再换（不成风暴）", async () => {
    const world = await setup();
    await expect(stream()).resolves.toBe("opened");
    expect(opened).toEqual(["c1"]);

    const first = world.channel;
    world.setPeer("offline");
    first.close();
    expect(world.provider.invalidate).toHaveBeenCalledWith(B);

    await expect(stream()).resolves.toBe("closed");
    expect(world.provider.getAccess).toHaveBeenCalledTimes(1);
    // 几条流同时在退避里醒来：冷却内一次也不再换，也都不碰旧通道。
    await expect(Promise.all([stream(), stream(), stream()])).resolves.toEqual([
      "closed",
      "closed",
      "closed",
    ]);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["c1"]);

    // 请求同样不发到已关的通道上。
    const calls = first.fetch.mock.calls.length;
    await expect(localSource.fetch(`${RELAY_B}/api/x`)).rejects.toThrow();
    expect(first.fetch.mock.calls.length).toBe(calls);

    // 冷却过后、主机已经回来：流的下一次重连换上新通道。
    world.setPeer("online");
    world.clock.at += CHANNEL_RETRY_MS;
    await expect(stream()).resolves.toBe("opened");
    expect(world.provider.getAccess).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(["c1", "c2"]);
  });

  it("主机回来：recover 不等冷却换一条新通道，流在新通道上恢复", async () => {
    const world = await setup();
    await stream();
    world.setPeer("offline");
    world.channel.close();
    await expect(stream()).resolves.toBe("closed");

    world.setPeer("online");
    await expect(world.entered.recover()).resolves.toBe(true);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(2);
    await expect(stream()).resolves.toBe("opened");
    expect(opened).toEqual(["c1", "c2"]);
    // 通道好着时 recover 不再换。
    await expect(world.entered.recover()).resolves.toBe(true);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(2);
  });

  it("没有上线事件（隧道换节点）：流的重连自己换上新通道；并发的只换一次", async () => {
    const world = await setup();
    await stream();
    world.channel.close();
    await expect(Promise.all([stream(), stream(), stream()])).resolves.toEqual([
      "opened",
      "opened",
      "opened",
    ]);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["c1", "c2", "c2", "c2"]);
  });

  it("令牌快过期、通道断着又在冷却里：请求不各自续期，续期只交给换通道", async () => {
    const world = await setup({ expiresAtMs: 1_000_000 + 10_000 });
    await stream();
    world.setPeer("offline");
    world.channel.close();
    await expect(stream()).resolves.toBe("closed");
    const tries = vi.mocked(world.provider.getAccess).mock.calls.length;
    const refreshTries = vi.mocked(world.provider.refresh).mock.calls.length;
    await Promise.all(
      [1, 2, 3].map(() =>
        localSource.fetch(`${RELAY_B}/api/x`).catch(() => undefined),
      ),
    );
    expect(world.provider.getAccess).toHaveBeenCalledTimes(tries);
    // 要防的退化走的是续期（refresh），只数取访问测不出来。
    expect(world.provider.refresh).toHaveBeenCalledTimes(refreshTries);
  });

  it("用户点「重连」：冷却里也立刻换通道，流在新通道上恢复", async () => {
    const world = await setup();
    await stream();
    world.setPeer("offline");
    world.channel.close();
    await expect(stream()).resolves.toBe("closed");
    const tries = vi.mocked(world.provider.getAccess).mock.calls.length;

    world.setPeer("online");
    // 还在冷却里：自动重试不换。
    await expect(stream()).resolves.toBe("closed");
    expect(world.provider.getAccess).toHaveBeenCalledTimes(tries);
    await expect(reconnectLocalTransport()).resolves.toBe(true);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(tries + 1);
    await expect(stream()).resolves.toBe("opened");
    expect(opened).toEqual(["c1", "c2"]);
  });

  it("换通道只重取访问、不轮换刷新令牌；之后真被 core 拒了才续", async () => {
    const world = await setup();
    await stream();
    world.channel.close();
    await expect(world.entered.recover()).resolves.toBe(true);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(1);
    expect(world.provider.refresh).not.toHaveBeenCalled();
    await expect(stream()).resolves.toBe("opened");

    refusals = 1;
    const answer = await localSource.fetch(`${RELAY_B}/api/x`);
    expect(answer.status).toBe(200);
    expect(world.provider.refresh).toHaveBeenCalledTimes(1);
  });

  it("换通道期间新通道又关了：不在它上面开流，冷却过后再换一条", async () => {
    const world = await setup();
    await stream();
    world.channel.close();
    world.dropNextChannel();
    await expect(world.entered.recover()).resolves.toBe(false);
    expect(world.provider.getAccess).toHaveBeenCalledTimes(1);
    expect(world.provider.invalidate).toHaveBeenCalledTimes(2);
    await expect(stream()).resolves.toBe("closed");
    expect(opened).toEqual(["c1"]);

    world.clock.at += CHANNEL_RETRY_MS;
    await expect(stream()).resolves.toBe("opened");
    expect(world.provider.getAccess).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(["c1", "c3"]);
  });
});
