// @vitest-environment jsdom
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listInvitations = vi.fn();
const canManage = vi.fn();

vi.mock("@/api/accounts", () => ({
  listInvitations: () => listInvitations(),
}));
vi.mock("@/app/use-access", () => ({
  useAccess: () => ({ member: true, can: canManage, session: undefined }),
}));
vi.mock("@/app/use-agents", () => ({
  useAgentsQuery: () => ({ data: [] }),
}));
vi.mock("@/host/use-host-connection", () => ({
  useHostConnection: () => ({ state: { status: "ok" }, check: vi.fn() }),
}));

import { useSettingsNavBadges } from "./nav-badges";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSettingsNavBadges 的邀请查询", () => {
  beforeEach(() => {
    listInvitations.mockReset();
    canManage.mockReset();
  });

  it("没有 identity:manage 的人不发邀请列表（发了必然 403）", async () => {
    canManage.mockReturnValue(false);
    renderHook(() => useSettingsNavBadges(new Set(["accounts"])), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listInvitations).not.toHaveBeenCalled();
  });

  it("能管理账号的人照常查，待接受的邀请数进徽标", async () => {
    canManage.mockReturnValue(true);
    listInvitations.mockResolvedValue([
      { invitationId: "a", consumedAtMs: 0, expiresAtMs: Date.now() + 60_000 },
    ]);
    const { result } = renderHook(
      () => useSettingsNavBadges(new Set(["accounts"])),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.accounts).toEqual({ kind: "count", count: 1 }),
    );
  });
});
