import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parseConnect } from "@armadra/shared";

import { EventBus, type WorkspaceEvent } from "../bus";
import { openFreshDatabase } from "../db/fresh.fixture";
import type { GatewayConnectHalf } from "../gateway";
import { type RpcHandle, installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import { startKit, type Kit } from "../contract/parity-kit";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import {
  type RequestIdentity,
  installRouteGuard,
  resetRouteGuard,
} from "../identity/gate";
import { createRouteGuard } from "../identity/route-access";
import { permits } from "../identity/scopes";
import type { CoreContext } from "../main";
import { type CoreLog, nodePlatform } from "../platform";
import type { RelayConnectHalf } from "../relay";
import { tempDir } from "../testing/temp-dir";
import { ConnectDomain, install } from "./index";

vi.mock("../events", () => ({
  eventStream: () => ({ watchedWorkspaces: () => ["ws-1"] }),
}));

/**
 * `connect.offer`（契约 §99.1）：四种在场状态、二维码文本、同一时刻只活一枚、
 * `connect.used` 事件、审计与日志里没有票和秘密、只有 owner。两半用假的：真 Gateway 的
 * 票与真中继的秘密在各自的测试里验过（`identity/service.test.ts`、`relay/connect.test.ts`）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const SOURCE = "0123456789abcdef0123456789abcdef";
const TICKET = `${"a".repeat(32)}.${"b".repeat(43)}`;
const SECRET = "S".repeat(22);

interface Direct extends GatewayConnectHalf {
  revoked: number;
  fireUsed(): void;
}
interface Relay extends RelayConnectHalf {
  revoked: number;
  fireUsed(): void;
}

function direct(over: Partial<GatewayConnectHalf> = {}): Direct {
  const listeners = new Set<() => void>();
  const half: Direct = {
    sourceId: SOURCE,
    origins: ["https://192.168.1.20:8443", "https://mac.local:8443"],
    ticket: TICKET,
    expiresAtMs: Date.now() + 120_000,
    fingerprint: "f".repeat(64),
    code: "ABCD-2345",
    webUrl: "https://192.168.1.20:8443/#pair=x",
    servesWeb: true,
    revoked: 0,
    revoke: () => {
      half.revoked += 1;
    },
    onUsed: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fireUsed: () => listeners.forEach((one) => one()),
    ...over,
  };
  return half;
}

function relay(over: Partial<RelayConnectHalf> = {}): Relay {
  const listeners = new Set<() => void>();
  const half: Relay = {
    sourceId: SOURCE,
    identityPub: "A".repeat(43),
    identityFingerprint: "FPRINT",
    secret: SECRET,
    issuers: ["https://app.armadra.com"],
    expiresAtMs: Date.now() + 300_000,
    revoked: 0,
    revoke: () => {
      half.revoked += 1;
    },
    onUsed: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fireUsed: () => listeners.forEach((one) => one()),
    ...over,
  };
  return half;
}

let handle: RpcHandle;
let kit: Kit;
let server: CoreServer;
let bus: EventBus;
let domain: ConnectDomain;
let audits: AuditEvent[];
let logged: unknown[];
let halves: { direct?: Direct; relay?: Relay };
const closing: (() => void | Promise<void>)[] = [];

beforeAll(async () => {
  const directory = tempDir("armadra-connect-");
  const opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir);
  closing.push(opened.close);
  logged = [];
  const log: CoreLog = {
    debug: (m, f) => logged.push([m, f]),
    info: (m, f) => logged.push([m, f]),
    warn: (m, f) => logged.push([m, f]),
    error: (m, f) => logged.push([m, f]),
  };
  audits = [];
  installAuditSink((event) => audits.push(event));
  bus = new EventBus();
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log,
  });
  server = new CoreServer({ platform, bus, version: "0.0.0-test" });
  closing.push(() => server.close());
  const context: CoreContext = {
    dataDir: directory,
    db: opened,
    server,
    bus,
    platform,
    log,
  };
  halves = {};
  domain = install(context, {
    direct: () => halves.direct,
    relay: () => Promise.resolve(halves.relay),
  });
  handle = installContract(server, { validateOutput: true, platform });
  const identities: Record<string, RequestIdentity | undefined> = {
    owner: { subject: { principalId: "owner", kind: "owner", scopes: [] } },
    member: { subject: { principalId: "member", kind: "member", scopes: [] } },
  };
  kit = await startKit(server, (name) => identities[name]);
  installRouteGuard(
    createRouteGuard({
      database: opened.database,
      permits: (who, required) => permits([...who.scopes], required),
      effectiveScopes: (who) => [...who.scopes],
    }),
  );
});

afterEach(() => {
  domain.close();
  halves = {};
  audits.length = 0;
});

afterAll(async () => {
  void handle;
  resetRouteGuard();
  resetAuditSink();
  for (const close of closing.splice(0)) await close();
});

const offer = (as = "owner") => kit.procedure("connect.offer", undefined, as);

describe("connect.offer 的四种在场状态", () => {
  it("只开局域网：只有直连半，二维码是 Gateway 的网页链接", async () => {
    halves.direct = direct();
    const answer = await offer();
    expect(answer.status).toBe(200);
    const body = answer.body as {
      uri: string;
      direct: { origins: string[]; code: string; webUrl: string };
      relay: unknown;
      expiresAtMs: number;
    };
    expect(body.relay).toBeNull();
    expect(body.direct).toMatchObject({
      origins: ["https://192.168.1.20:8443", "https://mac.local:8443"],
      code: "ABCD-2345",
    });
    expect(body.uri.startsWith("https://192.168.1.20:8443/#c=2&")).toBe(true);
    expect(body.expiresAtMs).toBe(halves.direct.expiresAtMs);
    const parsed = parseConnect(body.uri);
    expect(parsed.ok && parsed.payload).toMatchObject({
      sourceId: SOURCE,
      relay: null,
      direct: { ticket: TICKET },
    });
  });

  it("只开互联网：只有中转半，二维码指向第一个签发方的网页", async () => {
    halves.relay = relay({
      issuers: ["https://app.armadra.com", "https://relay.example.org"],
    });
    const body = (await offer()).body as {
      uri: string;
      direct: unknown;
      relay: { issuers: string[]; identityFingerprint: string };
    };
    expect(body.direct).toBeNull();
    expect(body.relay).toEqual({
      issuers: ["https://app.armadra.com", "https://relay.example.org"],
      identityFingerprint: "FPRINT",
    });
    expect(body.uri.startsWith("https://app.armadra.com/#c=2&")).toBe(true);
    const parsed = parseConnect(body.uri);
    expect(parsed.ok && parsed.payload.relay?.secret).toBe(SECRET);
  });

  it("两者都开：一张码两半，截止取最早的；Gateway 没有页面时网页取签发方", async () => {
    halves.direct = direct({ expiresAtMs: Date.now() + 120_000 });
    halves.relay = relay();
    const both = (await offer()).body as { uri: string; expiresAtMs: number };
    expect(both.expiresAtMs).toBe(halves.direct.expiresAtMs);
    expect(both.uri.startsWith("https://192.168.1.20:8443/#c=2&")).toBe(true);
    const parsed = parseConnect(both.uri);
    expect(
      parsed.ok && parsed.payload.direct && parsed.payload.relay,
    ).toBeTruthy();

    halves.direct = direct({ servesWeb: false });
    halves.relay = relay();
    const bare = (await offer()).body as { uri: string };
    expect(bare.uri.startsWith("https://app.armadra.com/#c=2&")).toBe(true);
  });

  it("都没开：409 connect_unavailable", async () => {
    const answer = await offer();
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "connect_unavailable" });
  });

  it("中转半的签发方一个都不合规：丢掉并作废那一枚", async () => {
    halves.direct = direct();
    halves.relay = relay({ issuers: ["not a url"] });
    const relayHalf = halves.relay;
    const body = (await offer()).body as { relay: unknown };
    expect(body.relay).toBeNull();
    expect(relayHalf.revoked).toBe(1);
  });
});

describe("一枚 offer 的生与灭", () => {
  it("新的 offer 作废旧的两半；没有可用的路时旧的也作废", async () => {
    const first = { direct: direct(), relay: relay() };
    halves = { ...first };
    await offer();
    expect(first.direct.revoked + first.relay.revoked).toBe(0);
    halves = { direct: direct(), relay: relay() };
    await offer();
    expect(first.direct.revoked).toBe(1);
    expect(first.relay.revoked).toBe(1);
    const second = halves;
    halves = {};
    expect((await offer()).status).toBe(409);
    expect(second.direct?.revoked).toBe(1);
    expect(second.relay?.revoked).toBe(1);
  });

  it("任一半被兑换：发 connect.used 带路线；换掉之后旧 offer 的兑换不再发", async () => {
    const seen: WorkspaceEvent[] = [];
    const off = bus.on("workspace.event", ({ event }) => seen.push(event));
    halves = { direct: direct(), relay: relay() };
    const first = halves;
    await offer();
    first.direct?.fireUsed();
    first.relay?.fireUsed();
    expect(seen).toEqual([
      { type: "connect.used", route: "direct" },
      { type: "connect.used", route: "relay" },
    ]);
    halves = { direct: direct(), relay: relay() };
    await offer();
    first.direct?.fireUsed();
    expect(seen).toHaveLength(2);
    off();
  });
});

describe("票和秘密不外泄", () => {
  it("审计只有三个布尔值；审计与日志里没有票、秘密、短码", async () => {
    halves = { direct: direct(), relay: relay() };
    await offer();
    expect(audits).toEqual([
      {
        action: "connect.offer.issue",
        detail: { direct: true, relay: true, code: true },
      },
    ]);
    const trail = JSON.stringify([audits, logged]);
    for (const secret of [TICKET, SECRET, "ABCD-2345", "AAAAAAAAAA"]) {
      expect(trail).not.toContain(secret);
    }
  });
});

describe("谁能调", () => {
  it("成员 403，不铸任何东西", async () => {
    halves = { direct: direct(), relay: relay() };
    const answer = await offer("member");
    expect(answer.status).toBe(403);
    expect(audits).toEqual([]);
    expect(halves.direct?.revoked).toBe(0);
  });
});
