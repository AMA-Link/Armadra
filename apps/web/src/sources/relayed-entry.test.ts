import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentAccessToken,
  resetIdentityCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import type { CloudSource } from "./cloud-client";
import type { RelaySession } from "./relay-access";
import {
  type RelayedEntryOptions,
  createRelayedEntry,
  relayedDescriptor,
} from "./relayed-entry";
import type { RemoteStreamOptions } from "./remote-stream";
import type { EnterRouteOptions } from "./route-entry";
import {
  type CredentialProvider,
  type SourceAccess,
  SourceError,
} from "./types";

/**
 * 会话来源无关的那一半：来源只注入 provider、换票凭据、列目录与会话保存处，
 * 其余（状态机、`me.stream` 目标、对账、`enter` 的会话存处）都在这里。
 */

const ISSUER = "https://relay.example";
const SOURCE = "a".repeat(32);

afterEach(() => {
  setHostedSession(null);
  setHostedRuntimeBase(null);
  resetIdentityCredentials();
});

const access: SourceAccess = {
  accessToken: "core-a",
  expiresAtMs: Date.now() + 900_000,
  httpBase: `${ISSUER}/s/${SOURCE}`,
  wsBase: `wss://relay.example/s/${SOURCE}`,
};

function setup(over: Partial<RelayedEntryOptions> = {}) {
  const provider: CredentialProvider = {
    getAccess: vi.fn(async () => access),
    refresh: vi.fn(async () => access),
    invalidate: vi.fn(),
  };
  const stored = new Map<string, RelaySession>([
    [SOURCE, { accessToken: "core-a", refreshToken: "core-r", expiresAtMs: 1 }],
  ]);
  const sessions = {
    load: vi.fn(async (id: string) => stored.get(id)),
    save: vi.fn((id: string, session: RelaySession) => {
      stored.set(id, session);
    }),
    clear: vi.fn(() => stored.clear()),
  };
  let listed: CloudSource[] = [
    { sourceId: SOURCE, name: "laptop", online: true } as CloudSource,
  ];
  let stream: RemoteStreamOptions | null = null;
  const enter = vi.fn(async (options: EnterRouteOptions) => {
    const route = { via: "relayed" as const, access };
    options.useRoute(route);
    return {
      route,
      renew: async () => true,
      recover: async () => true,
      dispose: () => undefined,
    };
  });
  const onEntered = vi.fn();
  const onRevoked = vi.fn();
  const mount = vi.fn(() => ({
    registry: { list: () => [], get: () => undefined },
    dispose: () => undefined,
  }));
  const entry = createRelayedEntry({
    issuer: ISSUER,
    provider,
    streamAuth: { access: async () => "cloud-a", invalidate: () => undefined },
    listSources: async () => listed,
    sessions,
    onEntered,
    onRevoked,
    enter: enter as never,
    wake: vi.fn(),
    mount: mount as never,
    createStream: (options) => {
      stream = options;
      return { issuer: ISSUER, state: "open", close: () => undefined };
    },
    ...over,
  });
  return {
    entry,
    provider,
    sessions,
    onEntered,
    onRevoked,
    mount,
    stream: () => stream!,
    setListed: (next: CloudSource[]) => {
      listed = next;
    },
  };
}

describe("经中继进主机（与会话来源无关）", () => {
  it("进主机：会话从注入的保存处读回，记下这台，挂上目录里其余的主机", async () => {
    const other = { sourceId: "b".repeat(32), name: "desk" };
    const { entry, sessions, onEntered, mount, stream } = setup({
      directory: () => [other],
    });
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    expect(entry.status.state).toBe("ready");
    expect(sessions.load).toHaveBeenCalledWith(SOURCE);
    expect(currentAccessToken()).toBe("core-a");
    expect(onEntered).toHaveBeenCalledWith({
      sourceId: SOURCE,
      name: "laptop",
    });
    expect(mount).toHaveBeenCalledWith(
      expect.objectContaining({
        siblings: [relayedDescriptor(ISSUER, other)],
      }),
    );
    expect(stream().issuer).toBe(ISSUER);
  });

  it("流重开对账：当前主机不在注入的目录里 → 先 onRevoked 再 unauthorized", async () => {
    const { entry, provider, onRevoked, stream, setListed } = setup();
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    setListed([]);
    const order: string[] = [];
    onRevoked.mockImplementation(() => order.push(entry.status.state));
    stream().onOpen?.();
    await vi.waitFor(() => expect(entry.status.state).toBe("unauthorized"));
    expect(order).toEqual(["ready"]);
    expect(onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ code: "source_access_denied" }),
    );
    expect(provider.invalidate).toHaveBeenCalledWith(SOURCE);
  });

  it("没有会话可续：unauthorized 并抛", async () => {
    const { entry, sessions } = setup();
    sessions.load.mockResolvedValue(undefined);
    await expect(
      entry.enter({ sourceId: SOURCE, name: "laptop" }),
    ).rejects.toMatchObject({ code: "source_unauthorized" });
    expect(entry.status.state).toBe("unauthorized");
  });

  it("signOut：清掉注入的会话、作废凭据、回到 idle", async () => {
    const { entry, sessions, provider } = setup();
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    const seen: string[] = [];
    entry.subscribe(() => seen.push(entry.status.state));
    entry.signOut();
    expect(sessions.clear).toHaveBeenCalledTimes(1);
    expect(provider.invalidate).toHaveBeenCalledWith(SOURCE);
    expect(entry.status).toEqual({
      state: "idle",
      lastError: null,
      relayDown: false,
    });
    expect(seen).toEqual(["idle"]);
  });

  it("再次 enter：先卸下上一次的路由与流", async () => {
    const disposed = vi.fn();
    const closed = vi.fn();
    const { entry } = setup({
      enter: (async (options: EnterRouteOptions) => {
        const route = { via: "relayed" as const, access };
        options.useRoute(route);
        return {
          route,
          renew: async () => true,
          recover: async () => true,
          dispose: disposed,
        };
      }) as never,
      createStream: () => ({
        issuer: ISSUER,
        state: "open",
        close: closed,
      }),
    });
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    expect(disposed).not.toHaveBeenCalled();
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalled();
    expect(entry.status.state).toBe("ready");
  });

  it("close：只卸下，记下的会话留着（刷新、重进还能续）", async () => {
    const { entry, sessions, provider } = setup();
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    entry.close();
    expect(sessions.clear).not.toHaveBeenCalled();
    expect(provider.invalidate).toHaveBeenCalledWith(SOURCE);
    expect(entry.status.state).toBe("idle");
  });

  it("verify 明确拒绝：不算进去，unauthorized 并抛，读进来的令牌丢掉", async () => {
    const verify = vi.fn(async () => {
      throw new SourceError("source_unauthorized");
    });
    const { entry, onEntered } = setup({ verify });
    await expect(
      entry.enter({ sourceId: SOURCE, name: "laptop" }),
    ).rejects.toMatchObject({ code: "source_unauthorized" });
    expect(verify).toHaveBeenCalledWith({ sourceId: SOURCE, name: "laptop" });
    expect(onEntered).not.toHaveBeenCalled();
    expect(entry.status.state).toBe("unauthorized");
    expect(currentAccessToken()).toBe("");
  });

  it("verify 连不上（网络错误）：不当成未授权，令牌留着，状态是 offline", async () => {
    const verify = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { entry, onEntered } = setup({ verify });
    await expect(
      entry.enter({ sourceId: SOURCE, name: "laptop" }),
    ).rejects.toMatchObject({ code: "source_unreachable" });
    expect(onEntered).not.toHaveBeenCalled();
    expect(entry.status.state).toBe("offline");
    expect(currentAccessToken()).toBe("core-a");
  });

  it("onStreamEvent：不带当前主机的事件（成员变化）也先交给来源", async () => {
    const onStreamEvent = vi.fn();
    const { entry, stream } = setup({ onStreamEvent });
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    const member = {
      type: "memberChanged" as const,
      teamId: "team-1",
      accountId: "acct-1",
    };
    stream().onEvent(member);
    stream().onEvent({ type: "grantChanged", sourceId: SOURCE });
    expect(onStreamEvent).toHaveBeenNthCalledWith(1, member);
    expect(onStreamEvent).toHaveBeenNthCalledWith(2, {
      type: "grantChanged",
      sourceId: SOURCE,
    });
    expect(entry.status.state).toBe("ready");
  });

  it("streamTicket：换票交给来源，不带 Bearer 凭据", async () => {
    const streamTicket = vi.fn(async () => "ticket-1");
    const { entry, stream } = setup({ streamAuth: undefined, streamTicket });
    await entry.enter({ sourceId: SOURCE, name: "laptop" });
    expect(stream().auth).toBeUndefined();
    expect(await stream().ticket?.()).toBe("ticket-1");
  });
});
