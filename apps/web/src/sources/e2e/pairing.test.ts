// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { E2eClientChannel } from "@armadra/shared/e2e";
import {
  ed25519SignerFromSeed,
  identityFingerprint,
} from "@armadra/platform-protocol/e2e";

import { E2eChannels, resetE2eChannels } from "./manager";
import { parsePairingUri, storagePairings } from "./pairing";
import { storagePins } from "./pins";

/** 配对二维码与访客链接的钉扎（契约 §80）。 */

const SOURCE = "a".repeat(32);
const IDENTITY = new Uint8Array(32).fill(4);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function uri(over: Record<string, unknown> = {}) {
  const data = {
    v: 1,
    s: SOURCE,
    k: b64(IDENTITY),
    p: b64(new Uint8Array(16).fill(9)),
    i: ["https://relay.test"],
    e: Date.now() + 60_000,
    ...over,
  };
  return `armadra://pair-e2e?d=${b64(new TextEncoder().encode(JSON.stringify(data)))}`;
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
  it("解析出源、身份、秘密与远程服务；过期、别的链接与坏载荷都不认", () => {
    const offer = parsePairingUri(uri())!;
    expect(offer.sourceId).toBe(SOURCE);
    expect(offer.identityPub).toEqual(IDENTITY);
    expect(offer.secret).toHaveLength(16);
    expect(offer.issuers).toEqual(["https://relay.test"]);
    expect(parsePairingUri(uri({ e: Date.now() - 1 }))).toBeNull();
    expect(parsePairingUri(uri({ k: "short" }))).toBeNull();
    expect(parsePairingUri("https://relay.test/j/abc#x.y")).toBeNull();
  });

  it("扫过的配对：连那台时钉住二维码里的身份、带 proof，用过即删", async () => {
    const pairings = storagePairings(memory());
    pairings.remember(parsePairingUri(uri())!);
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
