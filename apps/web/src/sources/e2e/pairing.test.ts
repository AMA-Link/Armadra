// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { E2eClientChannel } from "@armadra/shared/e2e";
import {
  ed25519SignerFromSeed,
  identityFingerprint,
} from "@armadra/platform-protocol/e2e";

import { E2eChannels, resetE2eChannels } from "./manager";
import { offerFromConnect, storagePairings } from "./pairing";
import { storagePins } from "./pins";

/** 配对二维码与访客链接的钉扎（契约 §80）。 */

const SOURCE = "a".repeat(32);
const IDENTITY = new Uint8Array(32).fill(4);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** 连接手机二维码的中转半（契约 §99.2）。 */
function offer(over: { expiresAtMs?: number; identityPub?: string } = {}) {
  return offerFromConnect(SOURCE, over.expiresAtMs ?? Date.now() + 60_000, {
    identityPub: over.identityPub ?? b64(IDENTITY),
    secret: b64(new Uint8Array(16).fill(9)),
    issuers: ["https://relay.test"],
  });
}

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

function fakeChannel(identity: Uint8Array): E2eClientChannel {
  return {
    coreIdentity: identity,
    closed: false,
    expired: false,
    sas: "000000",
    close: vi.fn(),
    onClose: () => () => undefined,
  } as unknown as E2eClientChannel;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetE2eChannels();
});

describe("配对二维码", () => {
  it("解码出源、身份、秘密与远程服务；长度不对的不认", () => {
    const parsed = offer()!;
    expect(parsed.sourceId).toBe(SOURCE);
    expect(parsed.identityPub).toEqual(IDENTITY);
    expect(parsed.secret).toHaveLength(16);
    expect(parsed.issuers).toEqual(["https://relay.test"]);
    expect(offer({ identityPub: "short" })).toBeNull();
  });

  it("到期的配对记不住：取不到", () => {
    const pairings = storagePairings(memory(), () => Date.now());
    pairings.remember(offer({ expiresAtMs: Date.now() - 1 })!);
    expect(pairings.get(SOURCE)).toBeNull();
  });

  it("扫过的配对：连那台时钉住二维码里的身份、带 proof，用过即删", async () => {
    const pairings = storagePairings(memory());
    pairings.remember(offer()!);
    const signer = await ed25519SignerFromSeed(new Uint8Array(32).fill(1));
    const channels = new E2eChannels({
      pins: storagePins(null),
      pairings,
      deviceName: () => "Phone",
      device: async () => ({ signer, platform: "ios" }),
    });
    const open = vi
      .spyOn(E2eClientChannel, "open")
      .mockResolvedValue(fakeChannel(IDENTITY));
    await channels.channel({
      issuer: "https://relay.test",
      sourceId: SOURCE,
      base: `https://relay.test/s/${SOURCE}`,
      relayToken: "t",
    });
    expect(open.mock.calls[0]![0].pinned).toEqual(IDENTITY);
    expect(open.mock.calls[0]![0].proofSecret).toHaveLength(16);
    expect(pairings.get(SOURCE)).toBeNull();
  });
});

describe("访客链接的指纹前缀", () => {
  it("m2 里的身份对不上链接给的前缀：identity_changed", async () => {
    const signer = await ed25519SignerFromSeed(new Uint8Array(32).fill(2));
    const channels = new E2eChannels({
      pins: storagePins(null),
      pairings: storagePairings(memory()),
      deviceName: () => "Guest",
      device: async () => ({ signer, platform: "browser" }),
    });
    vi.spyOn(E2eClientChannel, "open").mockResolvedValue(fakeChannel(IDENTITY));
    const target = {
      issuer: "https://relay.test",
      sourceId: SOURCE,
      base: `https://relay.test/s/${SOURCE}`,
      relayToken: "t",
    };
    await expect(
      channels.channel({ ...target, fingerprintPrefix: "aaaaaaaaaaaaaaaa" }),
    ).rejects.toMatchObject({ code: "identity_changed" });
    const right = (await identityFingerprint(IDENTITY)).slice(0, 16);
    expect(
      await channels.channel({ ...target, fingerprintPrefix: right }),
    ).not.toBeNull();
  });
});
