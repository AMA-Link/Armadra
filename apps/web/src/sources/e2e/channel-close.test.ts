import { describe, expect, it } from "vitest";

import { ed25519SignerFromSeed } from "@armadra/platform-protocol/e2e";
import {
  E2eChannelError,
  E2eClientChannel,
  relayRefusal,
} from "@armadra/shared/e2e";

/**
 * 中继在握手中途关通道（令牌失效、源离线……）时，错误要带着中继的关闭码与原因
 * 出来，不能被「钉住了而 core 不答 m2」折成 identity_mismatch（#387）。
 */

/** 连上后（收到 m1）按给定码关掉的假 WebSocket。 */
function closingSocket(code: number, reason: string): typeof WebSocket {
  return class extends EventTarget {
    readyState = 1;
    binaryType = "blob";
    constructor() {
      super();
    }
    send() {
      queueMicrotask(() => {
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
      });
    }
    close() {}
  } as unknown as typeof WebSocket;
}

async function open(code: number, reason: string, pinned?: Uint8Array) {
  return E2eClientChannel.open({
    url: "wss://relay.test/s/x/_relay/e2e",
    relayToken: "t",
    sourceId: "a".repeat(32),
    device: await ed25519SignerFromSeed(new Uint8Array(32).fill(3)),
    platform: "browser",
    name: "t",
    pingIntervalMs: 0,
    WebSocket: closingSocket(code, reason),
    ...(pinned === undefined ? {} : { pinned }),
  });
}

describe("握手被中继关掉", () => {
  it("钉住时中继令牌失效（4401）：保留关闭码与原因，不是 identity_mismatch", async () => {
    const error = await open(
      4401,
      "relay_token_invalid",
      new Uint8Array(32),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(E2eChannelError);
    expect(error).toMatchObject({
      code: "handshake",
      closeCode: 4401,
      reason: "relay_token_invalid",
    });
  });

  it("钉住时对端直接重置（1006，没有中继码）仍判 identity_mismatch", async () => {
    await expect(open(1006, "", new Uint8Array(32))).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });
});

describe("relayRefusal", () => {
  const closed = (closeCode: number, reason?: string) =>
    new E2eChannelError("unreachable", "x", closeCode, reason);

  it("4404 靠原因分：e2e_unsupported 是旧 core，其余是源不在线；4409 是版本不认", () => {
    expect(relayRefusal(closed(4404, "e2e_unsupported"))).toBe("unsupported");
    expect(relayRefusal(closed(4404, "source_offline"))).toBe("offline");
    expect(relayRefusal(closed(4404))).toBe("offline");
    expect(relayRefusal(closed(4409, "protocol_unsupported"))).toBe(
      "unsupported",
    );
    expect(relayRefusal(closed(4401, "relay_token_invalid"))).toBeNull();
    expect(relayRefusal(new Error("x"))).toBeNull();
  });
});
