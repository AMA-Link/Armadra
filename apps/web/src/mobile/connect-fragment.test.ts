import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectPayload, connectUrl } from "@armadra/shared";

import { storagePairings } from "../sources/e2e/pairing";
import { adoptConnectFragment } from "./connect-fragment";
import { memoryStorage } from "./testing";

const SOURCE = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const A = "https://192.168.1.20:8443";
const TICKET = `${"a1".repeat(16)}.${"Qz3".repeat(14)}_-`;
const ANCHOR = "ab".repeat(32);

const payload = (over: Partial<ConnectPayload> = {}): ConnectPayload => ({
  sourceId: SOURCE,
  expiresAtMs: NOW + 120_000,
  direct: { origins: [A], ticket: TICKET, fingerprint: ANCHOR },
  relay: null,
  ...over,
});
const relay = {
  identityPub: "A".repeat(43),
  secret: "B".repeat(22),
  issuers: ["https://app.armadra.com"],
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

function at(href: string) {
  const url = new URL(href);
  const replaceState = vi.fn();
  return {
    location: {
      href,
      hash: url.hash,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    },
    history: { replaceState },
    replaceState,
  };
}

describe("手机浏览器里打开连接二维码（契约 §99.5）", () => {
  it("没有 #c=：什么也不做", () => {
    const page = at(`${A}/#pair=abc`);
    expect(adoptConnectFragment(page.location, page.history, NOW)).toEqual({
      kind: "none",
    });
    expect(page.replaceState).not.toHaveBeenCalled();
  });

  it("页面就是直连半的一个来源：改写成 #pair=…&fp=…，原来的配对流程接手", () => {
    const page = at(connectUrl(A, payload()));
    expect(adoptConnectFragment(page.location, page.history, NOW)).toEqual({
      kind: "adopted",
    });
    expect(page.replaceState).toHaveBeenCalledWith(
      null,
      "",
      `/#pair=${TICKET}&fp=${ANCHOR}`,
    );
  });

  it("只有中转半：记下秘密，改到 /h/<源>（控制台打开这台主机）", () => {
    const page = at(
      connectUrl("https://app.armadra.com", payload({ direct: null, relay })),
    );
    expect(adoptConnectFragment(page.location, page.history, NOW)).toEqual({
      kind: "adopted",
    });
    expect(page.replaceState).toHaveBeenCalledWith(null, "", `/h/${SOURCE}`);
    expect(
      storagePairings(localStorage, () => NOW).get(SOURCE)?.issuers,
    ).toEqual(["https://app.armadra.com"]);
  });

  it("两半都有但页面不在直连来源里（云的网页）：走中转", () => {
    const page = at(connectUrl("https://app.armadra.com", payload({ relay })));
    adoptConnectFragment(page.location, page.history, NOW);
    expect(page.replaceState).toHaveBeenCalledWith(null, "", `/h/${SOURCE}`);
  });

  it("过期、新版：抹掉片段，带回失败原因；直连半又不在页面来源且没有中转：不可达", () => {
    const expired = at(connectUrl(A, payload({ expiresAtMs: NOW - 61_000 })));
    expect(
      adoptConnectFragment(expired.location, expired.history, NOW),
    ).toEqual({ kind: "failure", failure: "offerExpired" });
    expect(expired.replaceState).toHaveBeenCalledWith(null, "", "/");
    const newer = at(connectUrl(A, payload()).replace("#c=2", "#c=3"));
    expect(adoptConnectFragment(newer.location, newer.history, NOW)).toEqual({
      kind: "failure",
      failure: "connectNewer",
    });
    const elsewhere = at(connectUrl("https://other.example.com", payload()));
    expect(
      adoptConnectFragment(elsewhere.location, elsewhere.history, NOW),
    ).toEqual({ kind: "failure", failure: "offerUnreachable" });
  });
});
