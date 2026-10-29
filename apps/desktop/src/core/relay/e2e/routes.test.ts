import { describe, expect, it } from "vitest";

import type { CoreRequest } from "../../http/router";
import { runAs, type RequestIdentity } from "../../identity/gate";
import { TunnelDuplex } from "../streams";
import type { DeviceRegistry, TrustedDeviceRow } from "./devices";
import type { ChannelPeer } from "./peer";
import { markChannelSocket } from "./peer";
import type { PairingSecrets } from "./pairing";
import { type E2eRouteDeps, e2eOperations } from "./routes";

/**
 * 「经中继却拿不出原生设备钥」的判定（契约 §88.7）里，集成测试走不到的两条：登记行不是
 * `trusted`（会话门本来就会先拦，这里是纵深的那一道），以及登记行与握手自报的平台各管一半。
 * 直接调 `e2eOperations`，用一条登记过的假通道流当连接。
 */

const PRINCIPAL = "p-owner";

function channelRequest(platform: string): CoreRequest {
  const socket = Object.create(TunnelDuplex.prototype) as object;
  Object.defineProperty(socket, "tunnel", {
    value: {
      channel: {
        deviceId: "dev-1",
        publicKey: new Uint8Array(32),
        label: "MacBook",
        platform,
        sas: "000000",
        channelId: 1,
      } satisfies ChannelPeer,
    },
  });
  markChannelSocket(socket);
  return { raw: { socket } } as unknown as CoreRequest;
}

function deps(row: Partial<TrustedDeviceRow> | undefined): E2eRouteDeps {
  return {
    devices: {
      store: {
        get: (deviceId: string, principalId: string) =>
          row === undefined || deviceId !== "dev-1" || principalId !== PRINCIPAL
            ? undefined
            : ({
                status: "trusted",
                platform: "desktop",
                ...row,
              } as TrustedDeviceRow),
      },
    } as unknown as DeviceRegistry,
    pairing: {
      issue: () => ({ secret: new Uint8Array(16), expiresAtMs: 1 }),
    } as unknown as PairingSecrets,
    identity: async () => ({ sourceId: "src", publicKey: new Uint8Array(32) }),
    deviceKey: {} as E2eRouteDeps["deviceKey"],
  };
}

const asOwner = <T>(work: () => T) =>
  runAs(
    { subject: { principalId: PRINCIPAL } } as unknown as RequestIdentity,
    work,
  );

async function pairing(
  row: Partial<TrustedDeviceRow> | undefined,
  claimed: string,
) {
  try {
    await asOwner(() =>
      e2eOperations(deps(row)).pairingSecret(channelRequest(claimed)),
    );
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("经通道的设备是不是原生端（契约 §88.7）", () => {
  it("登记行是 desktop、已受信，握手也自报 desktop：照常", async () => {
    expect(await pairing({}, "desktop")).toBe("ok");
  });

  it("登记行是 desktop，这次握手自报 browser：拒绝", async () => {
    expect(await pairing({}, "browser")).toBe("forbidden");
  });

  it("登记行不是 trusted（待确认、已撤销、已拒绝）：拒绝", async () => {
    for (const status of ["pending", "revoked", "rejected"] as const)
      expect(await pairing({ status }, "desktop")).toBe("forbidden");
  });

  it("这把钥对发起者没有登记行：拒绝", async () => {
    expect(await pairing(undefined, "desktop")).toBe("forbidden");
  });
});
