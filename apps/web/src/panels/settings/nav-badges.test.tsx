import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

const mocks = vi.hoisted(() => ({
  listInvitations: vi.fn(),
  resumeIdentity: vi.fn(),
}));

vi.mock("@/api/accounts", () => ({ listInvitations: mocks.listInvitations }));
vi.mock("@/api/identity", async (original) => ({
  ...(await original<typeof import("@/api/identity")>()),
  resumeIdentity: mocks.resumeIdentity,
}));
vi.mock("@/app/use-agents", () => ({
  useAgentsQuery: () => ({ data: [] }),
}));
vi.mock("@/host/use-host-connection", () => ({
  useHostConnection: () => ({ state: { status: "online" }, check: vi.fn() }),
}));

import { useSettingsNavBadges } from "./nav-badges";

const VISIBLE = new Set(["accounts"]);

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const session = (permissions: string[]) => ({
  scopes: permissions.map((permission) => ({ permission })),
});

afterEach(() => {
  cleanup();
  mocks.listInvitations.mockReset();
  mocks.resumeIdentity.mockReset();
});

describe("设置导航徽标：邀请数", () => {
  it("能管邀请（identity:manage）才拉邀请列表，并给出待接受的条数", async () => {
    mocks.resumeIdentity.mockResolvedValue(session(["identity:manage"]));
    mocks.listInvitations.mockResolvedValue([
      { consumedAtMs: 0, expiresAtMs: Date.now() + 60_000 },
      { consumedAtMs: 1, expiresAtMs: Date.now() + 60_000 },
    ]);
    const { result } = renderHook(() => useSettingsNavBadges(VISIBLE), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.accounts).toEqual({ kind: "count", count: 1 }),
    );
  });

  it("成员没有 identity:manage：不拉邀请列表（否则吃 403），也没有徽标", async () => {
    mocks.resumeIdentity.mockResolvedValue(session(["workspace:read"]));
    const { result } = renderHook(() => useSettingsNavBadges(VISIBLE), {
      wrapper,
    });
    await waitFor(() => expect(mocks.resumeIdentity).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.listInvitations).not.toHaveBeenCalled();
    expect(result.current.accounts).toBeUndefined();
  });
});
