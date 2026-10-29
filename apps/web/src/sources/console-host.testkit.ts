import { type Mock, vi } from "vitest";

import {
  type IdentitySession,
  restoreHostedCredentials,
} from "../api/identity";
import { memoryStorage, routedFetch } from "../mobile/testing";
import { type ChannelLike, hostSessionKey } from "./cloud-session-channel";
import {
  type ConsoleHostOptions,
  type GuestRelay,
  createConsoleHost,
} from "./console-host";
import type { E2eChannels } from "./e2e/manager";
import type { RemoteStreamOptions } from "./remote-stream";
import type { EnterRouteOptions } from "./route-entry";

/** `console-host*.test.ts` 共用的假控制台、假中继与访客记录。 */
export const ISSUER = "https://app.saas.example";
export const HOST = "c".repeat(32);
export const BASE = `https://${HOST}.src.saas.example`;
export const ACCOUNT = "acct-a";
export const assertion = () => ({
  assertion: "jws.assertion",
  assertionExpiresAtMs: Date.now() + 300_000,
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: Date.now() + 3_600_000,
  relayOrigin: "https://relay.saas.example",
  relayBaseUrl: BASE,
  online: true,
});

export const coreSession = (refresh: string) => ({
  hostId: HOST,
  expiresAtUnixMs: Date.now() + 900_000,
  csrfToken: "c".repeat(43),
  native: { accessToken: `access-${refresh}`, refreshToken: refresh },
});

export const detail = (over: Record<string, unknown> = {}) => ({
  sourceId: HOST,
  name: "host1",
  kind: "server",
  online: true,
  lastSeenAtMs: 1,
  owner: false,
  via: "team",
  relayOrigin: "https://relay.saas.example",
  coreVersion: "0.11.0",
  space: { kind: "team", teamId: "team-1" },
  trustedOrigins: [],
  capabilities: [],
  registeredAtMs: 1,
  ...over,
});

export const identitySession = (
  principalId: string,
  role = "member",
  scopes: { permission: string; workspaceId: string }[] = [],
): IdentitySession =>
  ({
    hostId: HOST,
    device: {
      deviceId: "d1",
      principalId,
      displayName: "",
      role,
      createdAtUnixMs: 0,
      revision: 0,
    },
    scopes,
    expiresAtUnixMs: 0,
  }) as IdentitySession;

/** 同源的几个标签页：`postMessage` 发给别的成员（不发给自己），异步。 */
export function channelBus() {
  const members = new Set<{
    listener: ((event: { data: unknown }) => void) | null;
  }>();
  return {
    open(): ChannelLike {
      const self = {
        listener: null as ((event: { data: unknown }) => void) | null,
      };
      members.add(self);
      return {
        postMessage(data) {
          for (const other of members)
            if (other !== self)
              queueMicrotask(() => other.listener?.({ data }));
        },
        addEventListener(_type, listener) {
          self.listener = listener;
        },
        close: () => members.delete(self),
      };
    },
  };
}

/** 卸下过的路由（`dispose` 调过几次，按进入的先后）。 */
export const routes: { disposed: number }[] = [];

/** 不碰真本机源：取访问、装上这一路，就当装好了。 */
export const fakeEnter = async (options: EnterRouteOptions) => {
  const access = await options.provider.getAccess(
    options.descriptor.sourceId,
    "relayed",
  );
  const route = { via: "relayed" as const, access };
  options.useRoute(route);
  const record = { disposed: 0 };
  routes.push(record);
  return {
    route,
    renew: async () => true,
    recover: async () => true,
    dispose: () => {
      record.disposed += 1;
    },
  };
};

export function setup(
  over: {
    storage?: Storage;
    bus?: ReturnType<typeof channelBus>;
    me?: () => Promise<unknown>;
    detail?: () => Promise<unknown>;
    assertion?: () => Promise<unknown>;
    login?: () => { status?: number; body: unknown };
    principal?: string;
    timers?: (() => void)[];
    later?: (run: () => void, ms: number) => unknown;
    enter?: typeof fakeEnter;
    guestStorage?: Storage;
    guestRelay?: () => GuestRelay;
  } = {},
) {
  const storage = over.storage ?? memoryStorage();
  let refreshed = 0;
  let logins = 0;
  const net = routedFetch({
    "POST /api/identity/cloud/login": () => {
      logins += 1;
      return (
        over.login?.() ?? { body: { session: coreSession(`login-${logins}`) } }
      );
    },
    "POST /api/identity/session/refresh": () => {
      refreshed += 1;
      return { body: coreSession(`rotated-${refreshed}`) };
    },
  });
  const awaitApproval = vi.fn(async () => true as const);
  const e2e = {
    channel: async () => ({ sas: "000000" }),
    fetchFor: () => net.fetch,
    socketFor: () => globalThis.WebSocket,
    awaitApproval,
    pinned: () => true,
    forget: () => undefined,
    close: () => undefined,
  } as unknown as E2eChannels;
  const client = {
    me: {
      get: vi.fn(
        over.me ??
          (async () => ({
            accountId: ACCOUNT,
            teams: [
              {
                teamId: "team-1",
                slug: "test-team",
                name: "T",
                role: "member",
              },
            ],
          })),
      ),
      streamTicket: vi.fn(async () => ({ ticket: "cookie-ticket" })),
    },
    sources: {
      get: vi.fn(over.detail ?? (async () => detail())),
      assertion: vi.fn(over.assertion ?? (async () => assertion())),
    },
  };
  const streams: RemoteStreamOptions[] = [];
  const identity = {
    resume: vi.fn(async () => identitySession(over.principal ?? "p-1")),
    logout: vi.fn(async () => undefined),
    restore: vi.fn((notify: boolean) => restoreHostedCredentials(notify)),
  };
  const timers = over.timers ?? [];
  let now = 0;
  const trusted: Mock<(sourceId: string) => void> = vi.fn();
  const options: ConsoleHostOptions = {
    trusted,
    hostId: HOST,
    issuer: ISSUER,
    client: client as never,
    storage,
    channel: (over.bus ?? channelBus()).open(),
    e2e,
    identity,
    scheduler: {
      now: () => now,
      setTimeout: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimeout: () => undefined,
    },
    setTimeout: over.later ?? ((run) => setTimeout(run, 0)),
    guestStorage: over.guestStorage ?? memoryStorage(),
    ...(over.guestRelay === undefined ? {} : { guestRelay: over.guestRelay }),
    entry: {
      enter: over.enter ?? fakeEnter,
      mount: (() => ({
        registry: { list: () => [], get: () => undefined },
        dispose: () => undefined,
      })) as never,
      wake: () => undefined,
      createStream: (stream) => {
        streams.push(stream);
        return { issuer: ISSUER, state: "open", close: () => undefined };
      },
      cloud: { fetch: net.fetch },
    },
  };
  const host = createConsoleHost(options);
  return {
    host,
    client,
    net,
    storage,
    trusted,
    identity,
    awaitApproval,
    timers,
    streams,
    logins: () => logins,
    refreshes: () => refreshed,
    advance: (ms: number) => {
      now += ms;
    },
    options,
  };
}

export const key = hostSessionKey(ACCOUNT, HOST);
export const record = (storage: Storage) =>
  JSON.parse(storage.getItem(key) ?? "null") as Record<string, string> | null;
