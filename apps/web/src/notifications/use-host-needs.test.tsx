import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestProviders } from "@/app/test-harness";
import { useHostNeedsSync } from "./use-host-needs";

/** 背书通知只在确认是主机 owner 时才问（契约 §81.1）：成员、会话还没回来、非 owner 角色都不问。 */

const devices = vi.hoisted(() => ({ endorsements: vi.fn(async () => []) }));
const access = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../api/devices", () => ({
  ENDORSEMENTS_QUERY_KEY: ["endorsements"],
  devicesApi: devices,
}));
vi.mock("../app/use-access", () => ({ useAccess: () => access.value }));

function Harness() {
  useHostNeedsSync();
  return null;
}

afterEach(() => {
  cleanup();
  devices.endorsements.mockClear();
});

const mount = async (value: Record<string, unknown>) => {
  access.value = value;
  render(
    <TestProviders>
      <Harness />
    </TestProviders>,
  );
  await new Promise((done) => setTimeout(done, 20));
};

describe("useHostNeedsSync 只给 owner 查", () => {
  it("桌面壳（没有会话）与会话报 owner 的：查", async () => {
    await mount({ member: false, session: undefined });
    await waitFor(() => expect(devices.endorsements).toHaveBeenCalledTimes(1));
    cleanup();
    await mount({ member: false, session: { device: { role: "owner" } } });
    await waitFor(() => expect(devices.endorsements).toHaveBeenCalledTimes(2));
  });

  it("成员、会话还没回来、会话报的不是 owner：不查", async () => {
    await mount({ member: true, session: undefined });
    await mount({ member: true, session: null });
    await mount({ member: false, session: { device: { role: "admin" } } });
    expect(devices.endorsements).not.toHaveBeenCalled();
  });
});
