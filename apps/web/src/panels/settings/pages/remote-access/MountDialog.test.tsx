import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  remoteSources: vi.fn(),
  mountRemoteSource: vi.fn(),
}));
vi.mock("../../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../../api/remote-services")>()),
  ...api,
}));

import { MountDialog } from "./dialogs";

const HOST = "h".repeat(32);
const remote = {
  serviceId: "svc",
  kind: "personal" as const,
  issuer: "https://relay.test:8102",
  label: "relay.test:8102",
  accountHint: "dev",
  fingerprint: "ab".repeat(32),
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: true,
  hasCredentials: true,
  defaultLabel: "",
  guest: false,
};
const summary = {
  kind: "desktop",
  online: true,
  lastSeenAtMs: 1,
  owner: true,
  via: "owner",
  relayOrigin: remote.issuer,
  coreVersion: "0.11.0",
  mounted: false,
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.listSources.mockResolvedValue({
    sources: [{ sourceId: HOST, kind: "local", label: "this-mac" }],
    remotes: [remote],
  });
  api.remoteSources.mockResolvedValue({
    sources: [
      { ...summary, sourceId: HOST, name: "self-row" },
      { ...summary, sourceId: "o".repeat(32), name: "studio" },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("从中转账号添加", () => {
  it("账号下的本机不列出（#587）", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MountDialog
          open
          remotes={[remote]}
          onClose={() => undefined}
          onMounted={() => undefined}
        />
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("studio")).toBeTruthy();
    // 源表到了才知道哪一行是本机。
    await vi.waitFor(() => expect(api.listSources).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(within(dialog).queryByText("self-row")).toBeNull(),
    );
    expect(
      within(dialog).getAllByRole("button", { name: "Connect" }),
    ).toHaveLength(1);
  });
});
