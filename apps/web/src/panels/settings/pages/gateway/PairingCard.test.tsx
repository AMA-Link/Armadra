import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConnectOffer } from "@armadra/shared";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { CaInstallGuide, defaultPlatform, PageCaGuide } from "./CaInstallGuide";
import { countdown, groupFingerprint, PairingCard } from "./PairingCard";

const FP = "ab".repeat(32);
const EXPIRES = Date.UTC(2026, 9, 3, 8, 2);
const SOURCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://192.168.1.20:8443";
const offer: ConnectOffer = {
  sourceId: SOURCE,
  expiresAtMs: EXPIRES,
  uri: `${ORIGIN}/#c=2&s=${SOURCE}&e=${EXPIRES}`,
  direct: {
    origins: [ORIGIN],
    fingerprint: FP,
    code: null,
    webUrl: `${ORIGIN}/#pair=t.k&fp=${FP}`,
  },
  relay: null,
};

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PairingCard", () => {
  it("二维码文本就是 offer.uri", () => {
    const { container } = render(
      <PairingCard
        offer={offer}
        busy={false}
        caHref={null}
        onNewOffer={vi.fn()}
        now={EXPIRES - 60_000}
      />,
    );
    expect(container.querySelector("svg")?.getAttribute("data-qr-text")).toBe(
      offer.uri,
    );
  });

  it("counts down, and once expired dims the code and promotes the new-code button", () => {
    const onNewOffer = vi.fn();
    const props = { offer, busy: false, caHref: null, onNewOffer };
    const { rerender } = render(
      <PairingCard {...props} now={EXPIRES - 61_000} />,
    );
    expect(screen.getByText("1:01 后过期")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "新配对码" }).dataset.variant,
    ).toBe("outline");

    rerender(<PairingCard {...props} now={EXPIRES + 1} />);
    expect(screen.getByText("已过期")).toBeTruthy();
    const renew = screen.getByRole("button", { name: "新配对码" });
    expect(renew.dataset.variant).toBe("default");
    expect(
      (screen.getByRole("button", { name: "复制链接" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(renew);
    expect(onNewOffer).toHaveBeenCalledTimes(1);
    // 没有 CA 可发时不给下载。
    expect(screen.queryByRole("link", { name: "下载 CA" })).toBeNull();
  });

  it("私网档位上画「配对码 XXXX-XXXX 倒计时」，过期时收起配对码", () => {
    const props = {
      offer: { ...offer, direct: { ...offer.direct!, code: "3F7K-9Q2M" } },
      busy: false,
      caHref: null,
      onNewOffer: vi.fn(),
    };
    const { rerender } = render(
      <PairingCard {...props} now={EXPIRES - 179_000} />,
    );
    expect(screen.getByText("配对码")).toBeTruthy();
    expect(screen.getByText("3F7K-9Q2M").tagName).toBe("KBD");
    expect(screen.getByText("2:59")).toBeTruthy();
    rerender(<PairingCard {...props} now={EXPIRES + 1} />);
    expect(screen.queryByText("3F7K-9Q2M")).toBeNull();
    expect(screen.getByText("已过期")).toBeTruthy();
  });

  it("没有来源下拉：直连半只画一行地址", () => {
    render(
      <PairingCard
        offer={{
          ...offer,
          direct: {
            ...offer.direct!,
            origins: [ORIGIN, "https://mac.local:8443"],
          },
        }}
        busy={false}
        caHref={null}
        onNewOffer={vi.fn()}
        now={EXPIRES - 60_000}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(ORIGIN)).toBeTruthy();
  });

  it("只开互联网：只有二维码与新配对码，没有地址、复制链接、指纹", () => {
    render(
      <PairingCard
        offer={{
          ...offer,
          direct: null,
          relay: {
            issuers: ["https://app.armadra.com"],
            identityFingerprint: "FP",
          },
        }}
        busy={false}
        caHref={null}
        onNewOffer={vi.fn()}
        now={EXPIRES - 60_000}
      />,
    );
    expect(screen.queryByText(ORIGIN)).toBeNull();
    expect(screen.queryByRole("button", { name: "复制链接" })).toBeNull();
    expect(screen.queryByText("指纹")).toBeNull();
    expect(screen.getByRole("button", { name: "新配对码" })).toBeTruthy();
  });

  it("formats the clock and the fingerprint the way certificate dialogs do", () => {
    expect(countdown(120_000)).toBe("2:00");
    expect(countdown(59_001)).toBe("1:00");
    expect(countdown(-5)).toBe("0:00");
    expect(groupFingerprint("ab01")).toBe("AB:01");
  });
});

describe("CaInstallGuide", () => {
  it("opens to steps for both platforms and a download of /ca.crt", () => {
    render(
      <CaInstallGuide
        href="https://192.168.1.20:8443/ca.crt"
        platform="android"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "安装证书" }));
    expect(screen.getByText(/CA 证书」，选中刚下载的文件/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "下载 CA" }).getAttribute("href"),
    ).toBe("https://192.168.1.20:8443/ca.crt");
    expect(screen.getByRole("tab", { name: "iOS" })).toBeTruthy();
  });

  it("guesses the platform from the user agent", () => {
    expect(defaultPlatform("Mozilla/5.0 (Linux; Android 15)")).toBe("android");
    expect(defaultPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0)")).toBe(
      "ios",
    );
  });

  it("draws nothing on a page that did not come through a gateway", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<PageCaGuide served />);
    // jsdom 的页面是 http：不是经 Gateway 打开的，连问都不问。
    expect(container.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
