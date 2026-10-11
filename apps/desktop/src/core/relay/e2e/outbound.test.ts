import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  memoryBackend,
  signAssertion,
} from "../../identity/cloud/fake.fixture";
import { SourceClient } from "../../sources/source-client";
import { CoreFailure } from "../../http/errors";
import { type RelayCore, relayCore, until } from "../core.fixture";
import { DeviceKey } from "./device-key";
import { OutboundChannels } from "./outbound";
import { e2eDevices } from "./peer";

/**
 * 本机作为客户端（桌面「我的其他电脑」）经端到端通道登录别的电脑（契约 §78）：
 * `sources` 域的 `SourceClient` 把经中继的请求交给通道；新设备答 `device_pending`
 * 带校验码；对端放行后登录成功，会话绑本机设备钥；对端身份记进源表的钉扎。
 */

let world: RelayCore;
let sourceId: string;
const pins = new Map<string, Uint8Array>();

beforeEach(async () => {
  world = await relayCore();
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
  pins.clear();
});

afterEach(async () => {
  await world.close();
});

function client(deviceKey = new DeviceKey(() => memoryBackend())) {
  const channels = new OutboundChannels({
    deviceKey,
    pins: {
      get: (id) => pins.get(id) ?? null,
      set: (id, pub) => pins.set(id, pub),
    },
    name: () => "My Laptop",
    anchor: async () => undefined,
  });
  const peer = new SourceClient(
    async () => {
      throw new Error("明文路径不该被用到");
    },
    (address, request) => channels.request(address, request),
  );
  const base = world.relay.url
    .replace(/\/t\/v1$/, `/s/${sourceId}`)
    .replace(/^ws/, "http");
  return {
    channels,
    peer,
    address: { base, fingerprint: "", relayToken: "relay-token", sourceId },
  };
}

describe("本机经端到端通道登录别的电脑", () => {
  it("待确认答 device_pending 带校验码；放行后登录成功并钉住对端身份", async () => {
    const { channels, peer, address } = client();
    let pending: CoreFailure | undefined;
    try {
      await peer.cloudLogin(
        address,
        signAssertion({ aud: sourceId, nowMs: Date.now() }),
      );
    } catch (error) {
      pending = error as CoreFailure;
    }
    expect(pending).toBeInstanceOf(CoreFailure);
    expect(pending?.code).toBe("device_pending");
    const details = pending?.details as { pendingId: string; sas: string };
    expect(details.sas).toBe(channels.current(sourceId)?.sas);
    expect(pins.get(sourceId)).toEqual(await world.cloud.identityPublicKey());
    // 对端主人核对之前，等候答 pending；核对后答 trusted。
    const waiting = channels.wait(sourceId, details.pendingId);
    e2eDevices()!.approve(details.pendingId, details.sas);
    expect(await waiting).toBe("trusted");
    const credentials = await peer.cloudLogin(
      address,
      signAssertion({ aud: sourceId, nowMs: Date.now() }),
    );
    expect(credentials.accessToken).not.toBe("");
    const row = e2eDevices()!.list()[0]!;
    expect(row).toMatchObject({
      status: "trusted",
      label: "My Laptop",
      platform: "desktop",
    });
    channels.close();
  });

  it("对端身份变了：identity_changed，不发请求", async () => {
    pins.set(sourceId, new Uint8Array(32).fill(3));
    const { peer, address } = client();
    await expect(
      peer.cloudLogin(
        address,
        signAssertion({ aud: sourceId, nowMs: Date.now() }),
      ),
    ).rejects.toMatchObject({ code: "identity_changed" });
  });
});
