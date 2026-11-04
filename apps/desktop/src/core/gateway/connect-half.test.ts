import { describe, expect, it, vi } from "vitest";

import type { CoreContext } from "../main";
import { GatewayDomain } from "./index";
import type { Gateway } from "./listener";
import { PairingCodes } from "./pairing-code";

/**
 * 「连接手机」的直连半（契约 §99.1）：来源集合去掉回环、最多 3 个，票绑这组来源，
 * 私网档位上配一枚短码，作废时票与短码一起没，票被兑换时通知。
 */

const HOST = "0123456789abcdef0123456789abcdef";
const TICKET = `${"a".repeat(32)}.${"A".repeat(43)}`;

function fake(
  origins: string[],
  over: { mode?: string; publicOrigins?: string[]; webRoot?: object } = {},
) {
  const pair = vi.fn((input: { origins?: readonly string[] }) => ({
    ticket: TICKET,
    expiresAtMs: 1_900_000_000_000,
    origin: input.origins?.[0] ?? "",
    origins: input.origins ?? [],
    fingerprint: "f".repeat(64),
    webUrl: `${input.origins?.[0]}/#pair=${TICKET}&fp=${"f".repeat(64)}`,
    deepLink: "armadra://pair?x",
  }));
  const revokeBootstrap = vi.fn();
  const listeners = new Set<(id: string) => void>();
  const gateway = {
    address: { host: "0.0.0.0", port: 8443 },
    hostId: HOST,
    mode: over.mode ?? "private",
    publicOrigins: over.publicOrigins ?? [],
    webRoot: over.webRoot,
    origins: () => origins,
    pair,
    service: {
      revokeBootstrap,
      onBootstrapConsumed: (listener: (id: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as Gateway;
  return { gateway, pair, revokeBootstrap, listeners };
}

function domain(codes = new PairingCodes()) {
  return {
    domain: new GatewayDomain({} as CoreContext, { pairingCodes: codes }),
    codes,
  };
}

describe("GatewayDomain.connectHalf", () => {
  it("没有 Gateway：没有直连半", () => {
    expect(domain().domain.connectHalf()).toBeUndefined();
  });

  it("只有回环来源：没有直连半，也不签票", () => {
    const { domain: d } = domain();
    const g = fake(["https://127.0.0.1:8443", "https://localhost:8443"]);
    d.adopt(g.gateway);
    expect(d.connectHalf()).toBeUndefined();
    expect(g.pair).not.toHaveBeenCalled();
  });

  it("去掉回环、保持顺序、最多 3 个；票绑这组来源", () => {
    const { domain: d } = domain();
    const g = fake([
      "https://127.0.0.1:8443",
      "https://192.168.1.20:8443",
      "https://mac.local:8443",
      "https://10.0.0.5:8443",
      "https://172.16.0.9:8443",
    ]);
    d.adopt(g.gateway);
    const half = d.connectHalf()!;
    expect(half.origins).toEqual([
      "https://192.168.1.20:8443",
      "https://mac.local:8443",
      "https://10.0.0.5:8443",
    ]);
    expect(g.pair).toHaveBeenCalledWith({ origins: half.origins });
    expect(half).toMatchObject({
      sourceId: HOST,
      ticket: TICKET,
      fingerprint: "f".repeat(64),
      servesWeb: false,
    });
    expect(half.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("配了对外来源的档位不配短码；有页面产物时 servesWeb", () => {
    const { domain: d, codes } = domain();
    const g = fake(["https://armadra.example.com"], {
      publicOrigins: ["https://armadra.example.com"],
      webRoot: {},
    });
    d.adopt(g.gateway);
    const half = d.connectHalf()!;
    expect(half.code).toBeNull();
    expect(half.servesWeb).toBe(true);
    expect(codes.size).toBe(0);
  });

  it("revoke：作废票并删掉它的短码", () => {
    const { domain: d, codes } = domain();
    const g = fake(["https://192.168.1.20:8443"]);
    d.adopt(g.gateway);
    const half = d.connectHalf()!;
    expect(codes.size).toBe(1);
    half.revoke();
    expect(g.revokeBootstrap).toHaveBeenCalledWith(TICKET);
    expect(codes.size).toBe(0);
  });

  it("只在这张票被兑换时通知", () => {
    const { domain: d } = domain();
    const g = fake(["https://192.168.1.20:8443"]);
    d.adopt(g.gateway);
    const half = d.connectHalf()!;
    const used = vi.fn();
    const off = half.onUsed(used);
    for (const listener of g.listeners) listener("someone-else");
    expect(used).not.toHaveBeenCalled();
    for (const listener of g.listeners) listener(TICKET.split(".")[0]!);
    expect(used).toHaveBeenCalledTimes(1);
    off();
    expect(g.listeners.size).toBe(0);
  });
});
