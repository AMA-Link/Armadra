import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const platform = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../../../../platform", async (original) => ({
  ...(await original<typeof import("../../../../platform")>()),
  ...platform,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/ui/toast", () => ({ toast: toasts }));

import { cloudConsoleUrl } from "../../../../api/remote-services";
import { RemoteRow } from "./rows";

/**
 * Armadra 云行的菜单（云端控制台 §3.5.1）：多一项「打开控制台」，系统浏览器打开
 * `<issuer>/me`；个人中转的行没有它。
 */

const remote = {
  serviceId: "cloud",
  kind: "saas",
  issuer: "https://cloud.test",
  label: "cloud.test",
  defaultLabel: "cloud.test",
  accountHint: "ada@example.test",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: true,
  hasCredentials: true,
  guest: false,
} as const;

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
});
afterEach(() => {
  cleanup();
  platform.openExternal.mockReset();
  toasts.error.mockReset();
});

function mount(onOpenConsole?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RemoteRow
        remote={remote}
        pending={null}
        tunnel={null}
        onSignIn={() => undefined}
        onSignOut={() => undefined}
        onRetryCleanup={() => undefined}
        onChangePassword={() => undefined}
        onRename={() => undefined}
        onRemove={() => undefined}
        {...(onOpenConsole === undefined ? {} : { onOpenConsole })}
      />
    </QueryClientProvider>,
  );
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Actions for cloud.test" }),
    { button: 0, ctrlKey: false },
  );
}

describe("打开控制台", () => {
  it("控制台地址是 <issuer>/me", () => {
    expect(cloudConsoleUrl("https://cloud.test")).toBe("https://cloud.test/me");
    expect(cloudConsoleUrl("https://cloud.test:8443/")).toBe(
      "https://cloud.test:8443/me",
    );
  });

  it("给了回调才有这一项，点了调用它", async () => {
    const open = vi.fn();
    mount(open);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open console" }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("没给回调（个人中转的行）：菜单里没有", async () => {
    mount();
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(screen.queryByRole("menuitem", { name: "Open console" })).toBeNull();
  });
});
