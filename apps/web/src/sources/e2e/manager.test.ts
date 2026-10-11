// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  E2E_LABELS,
  ed25519SignerFromSeed,
  ed25519Verify,
} from "@armadra/platform-protocol/e2e";
import { E2eChannelError, E2eClientChannel } from "@armadra/shared/e2e";

import { desktopDeviceKey } from "./device-key";
import {
  E2eAccessError,
  E2eChannels,
  pendingApprovals,
  resetE2eChannels,
} from "./manager";
import { storagePins } from "./pins";

/**
 * 页面这一侧的通道管理（契约 §78）：TOFU 钉扎、身份变了拒绝、从没建成过的源退回
 * 明文而建成过的不降级；桌面设备钥只签握手转录。
 */

const IDENTITY = new Uint8Array(32).fill(1);
const OTHER = new Uint8Array(32).fill(2);
const TARGET = {
  issuer: "https://relay.test",
  sourceId: "a".repeat(32),
  base: "https://relay.test/s/" + "a".repeat(32),
  relayToken: "token",
};

function fakeChannel(identity: Uint8Array): E2eClientChannel {
  return {
    coreIdentity: identity,
    closed: false,
    expired: false,
    sas: "123456",
    close: vi.fn(),
    onClose: () => () => undefined,
  } as unknown as E2eClientChannel;
}

async function manager() {
  const signer = await ed25519SignerFromSeed(new Uint8Array(32).fill(7));
  return new E2eChannels({
    pins: storagePins(null),
    deviceName: () => "Test",
    device: async () => ({ signer, platform: "browser" }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetE2eChannels();
});

describe("E2eChannels", () => {
  it("第一次连上记下身份（TOFU），之后复用同一条通道", async () => {
    const open = vi
      .spyOn(E2eClientChannel, "open")
      .mockResolvedValue(fakeChannel(IDENTITY));
    const channels = await manager();
    const first = await channels.channel(TARGET);
    const second = await channels.channel(TARGET);
    expect(first).toBe(second);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0].pinned).toBeNull();
    expect(open.mock.calls[0]![0].url).toBe(
      "wss://relay.test/s/" + "a".repeat(32) + "/_relay/e2e",
    );
    expect(channels.pinned(TARGET.issuer, TARGET.sourceId)).toBe(true);
  });

  it("钉过之后身份变了：identity_changed，不退回明文", async () => {
    const channels = await manager();
    vi.spyOn(E2eClientChannel, "open").mockResolvedValueOnce(
      fakeChannel(IDENTITY),
    );
    await channels.channel(TARGET);
    channels.close(TARGET.issuer, TARGET.sourceId);
    vi.spyOn(E2eClientChannel, "open").mockRejectedValueOnce(
      new E2eChannelError("identity_mismatch"),
    );
    await expect(channels.channel(TARGET)).rejects.toMatchObject({
      code: "identity_changed",
    });
  });

  it("连不上就失败，不退回明文：旧 core（4404/4409）答 unsupported，其余 unreachable", async () => {
    const channels = await manager();
    vi.spyOn(E2eClientChannel, "open").mockRejectedValueOnce(
      new E2eChannelError("unreachable"),
    );
    await expect(channels.channel(TARGET)).rejects.toMatchObject({
      code: "unreachable",
    });
    vi.spyOn(E2eClientChannel, "open").mockRejectedValueOnce(
      new E2eChannelError("unreachable", "e2e_unsupported", 4404),
    );
    await expect(channels.channel(TARGET)).rejects.toMatchObject({
      code: "unsupported",
    });
    vi.spyOn(E2eClientChannel, "open").mockRejectedValueOnce(
      new E2eChannelError("unreachable", "bad version", 4409),
    );
    await expect(channels.channel(TARGET)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("钉住的与 m2 的不同（防御：协议包没比上时）也拒绝", async () => {
    const channels = await manager();
    vi.spyOn(E2eClientChannel, "open").mockResolvedValueOnce(
      fakeChannel(IDENTITY),
    );
    await channels.channel(TARGET);
    channels.close(TARGET.issuer, TARGET.sourceId);
    vi.spyOn(E2eClientChannel, "open").mockResolvedValueOnce(
      fakeChannel(OTHER),
    );
    await expect(channels.channel(TARGET)).rejects.toBeInstanceOf(
      E2eAccessError,
    );
  });

  it("配对 / 访客链接给的身份不走 TOFU：直接钉", async () => {
    const channels = await manager();
    const open = vi
      .spyOn(E2eClientChannel, "open")
      .mockResolvedValue(fakeChannel(IDENTITY));
    await channels.channel({ ...TARGET, identityPub: IDENTITY });
    expect(open.mock.calls[0]![0].pinned).toEqual(IDENTITY);
  });

  it("等主人核对：校验码交给界面，放行后收起", async () => {
    const channels = await manager();
    const channel = fakeChannel(IDENTITY);
    const answers = [{ status: "pending" }, { status: "trusted" }];
    vi.spyOn(channels, "fetchFor").mockReturnValue(
      (async () =>
        new Response(JSON.stringify(answers.shift()), {
          status: 200,
        })) as typeof fetch,
    );
    const seen: string[] = [];
    const off = pendingApprovals.subscribe(() => {
      for (const one of pendingApprovals.snapshot()) seen.push(one.sas);
    });
    await channels.awaitApproval(
      { ...TARGET, label: "Mac" },
      channel,
      "p".repeat(32),
    );
    off();
    expect(seen).toContain("123456");
    expect(pendingApprovals.snapshot()).toEqual([]);
  });

  it("被拒：抛 device_rejected，界面留着拒绝的那一条", async () => {
    const channels = await manager();
    vi.spyOn(channels, "fetchFor").mockReturnValue(
      (async () =>
        new Response(JSON.stringify({ status: "rejected" }), {
          status: 200,
        })) as typeof fetch,
    );
    await expect(
      channels.awaitApproval(TARGET, fakeChannel(IDENTITY), "p".repeat(32)),
    ).rejects.toMatchObject({ code: "device_rejected" });
    expect(pendingApprovals.snapshot()[0]?.status).toBe("rejected");
  });
});

describe("桌面设备钥（e2e.sign）", () => {
  it("只把 32 字节转录交给本机 core，签名能按协议包的输入验过", async () => {
    const real = await ed25519SignerFromSeed(new Uint8Array(32).fill(5));
    const label = new TextEncoder().encode(E2E_LABELS.deviceSignature);
    const asked: string[] = [];
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    const signer = await desktopDeviceKey(async (transcript) => {
      asked.push(transcript);
      const h = Buffer.from(transcript, "base64url");
      const input = new Uint8Array([...label, ...h, ...real.publicKey]);
      return {
        publicKey: b64(real.publicKey),
        signature: b64(await real.sign(input)),
      };
    });
    const transcript = new Uint8Array(32).fill(9);
    const input = new Uint8Array([
      ...label,
      ...transcript,
      ...signer.publicKey,
    ]);
    const signature = await signer.sign(input);
    expect(await ed25519Verify(real.publicKey, signature, input)).toBe(true);
    expect(asked.at(-1)).toBe(b64(transcript));
    await expect(signer.sign(new Uint8Array(10))).rejects.toThrow();
  });
});
