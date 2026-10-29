import { afterEach, describe, expect, it, vi } from "vitest";

import { ed25519SignerFromSeed } from "@armadra/platform-protocol/e2e";
import { E2eClientChannel } from "@armadra/shared/e2e";

import { createRelayEnrollment } from "../../mobile/connect";
import { browserDevice } from "../cloud-client";
import { e2eChannels, pageDeviceName, resetE2eChannels } from "./manager";

/**
 * 端到端登记的设备名由页面定（#606）：控制台 `/h/` 与中继托管页按浏览器与系统，原生
 * App 仍是 iOS / Android。手机连接页的代码先建了共享通道也不能把浏览器登记成 iOS。
 */

vi.mock("./device-key", () => ({
  deviceIdentity: async () => ({
    signer: await ed25519SignerFromSeed(new Uint8Array(32).fill(7)),
    platform: "browser",
  }),
}));

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36";

const TARGET = {
  issuer: "https://relay.test",
  sourceId: "a".repeat(32),
  base: "https://relay.test/s/" + "a".repeat(32),
  relayToken: "token",
};

function page(href: string, userAgent: string, native = false) {
  vi.stubGlobal("location", new URL(href));
  vi.stubGlobal("navigator", { userAgent });
  if (native) vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
}

function openedName(): Promise<string> {
  const open = vi.spyOn(E2eClientChannel, "open").mockResolvedValue({
    coreIdentity: new Uint8Array(32).fill(1),
    closed: false,
    expired: false,
    sas: "123456",
    close: vi.fn(),
    onClose: () => () => undefined,
  } as unknown as E2eClientChannel);
  return e2eChannels()
    .channel(TARGET)
    .then(() => open.mock.calls[0]![0].name);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetE2eChannels();
});

describe("browserDevice", () => {
  it("名字是浏览器加系统", () => {
    expect(browserDevice(CHROME_MAC)).toEqual({
      platform: "browser",
      name: "Armadra Web (Chrome · macOS)",
    });
    expect(browserDevice(SAFARI_IPHONE).name).toBe(
      "Armadra Web (Safari · iOS)",
    );
    expect(
      browserDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
      ).name,
    ).toBe("Armadra Web (Firefox · Windows)");
    expect(browserDevice("").name).toBe("Armadra Web");
  });
});

describe("页面的端到端设备名", () => {
  it("控制台 /h/：手机连接页的代码先建了共享通道，登记的仍是浏览器与系统", async () => {
    page("https://console.test/h/host-1", CHROME_MAC);
    // 与 MobileRoot 一样：渲染时先建个人中转的添加流程（缺省依赖里取共享通道）。
    createRelayEnrollment();
    expect(pageDeviceName()).toBe("Armadra Web (Chrome · macOS)");
    await expect(openedName()).resolves.toBe("Armadra Web (Chrome · macOS)");
  });

  it("中继托管页 /app/ 按浏览器登记", async () => {
    page("https://relay.test/app/", SAFARI_IPHONE);
    await expect(openedName()).resolves.toBe("Armadra Web (Safari · iOS)");
  });

  it("原生 App 的名字不变：iOS 与 Android", async () => {
    page("capacitor://localhost/", SAFARI_IPHONE, true);
    await expect(openedName()).resolves.toBe("Armadra iOS");
    resetE2eChannels();
    vi.restoreAllMocks();
    page("https://localhost/", ANDROID_WEBVIEW, true);
    expect(pageDeviceName()).toBe("Armadra Android");
    await expect(openedName()).resolves.toBe("Armadra Android");
  });
});
