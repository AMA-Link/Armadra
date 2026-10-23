import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const api = vi.hoisted(() => ({
  addCloud: vi.fn(),
  pollCloudDevice: vi.fn(),
  cloudSpaces: vi.fn(),
  registerToSpace: vi.fn(),
}));
vi.mock("../../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../../api/remote-services")>()),
  ...api,
}));
const platform = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../../../../platform", async (original) => ({
  ...(await original<typeof import("../../../../platform")>()),
  ...platform,
}));

import { AddCloudDialog } from "./CloudDialog";

const remote = {
  serviceId: "svc",
  kind: "saas",
  issuer: "https://cloud.test",
  label: "cloud.test",
  accountHint: "",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 0,
  registered: false,
  hasCredentials: false,
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.addCloud.mockResolvedValue({
    remote,
    next: {
      deviceCode: {
        userCode: "ABCD-EFGH",
        verificationUrl: "https://cloud.test/device",
        expiresAtMs: Date.now() + 600_000,
        intervalMs: 10,
      },
    },
  });
  api.cloudSpaces.mockResolvedValue({
    spaces: [
      { kind: "personal", plan: "free" },
      {
        kind: "team",
        teamId: "t1",
        slug: "acme",
        name: "Acme",
        role: "admin",
        plan: "team",
      },
    ],
  });
  api.registerToSpace.mockResolvedValue({ remote, sourceId: "h" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <AddCloudDialog initialIssuer="" onClose={onClose} onChanged={onChanged} />,
  );
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: "https://cloud.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Get device code" }));
  return { onClose, onChanged };
}

describe("添加 Armadra 云", () => {
  it("显示设备码，批准后选空间登记，完成关闭", async () => {
    api.pollCloudDevice
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "ready" });
    const { onClose } = mount();
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(api.addCloud).toHaveBeenCalledWith("https://cloud.test");
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(platform.openExternal).toHaveBeenCalledWith(
      "https://cloud.test/device",
    );
    const register = await screen.findByRole("button", {
      name: "Register this computer",
    });
    expect(api.pollCloudDevice).toHaveBeenCalledTimes(2);
    fireEvent.click(register);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.registerToSpace).toHaveBeenCalledWith({
      serviceId: "svc",
      space: { kind: "personal" },
    });
  });

  it("被拒绝：停止轮询，给重新获取", async () => {
    api.pollCloudDevice.mockResolvedValue({ status: "denied" });
    mount();
    expect(await screen.findByText("Denied in the browser")).toBeTruthy();
    const calls = api.pollCloudDevice.mock.calls.length;
    await new Promise((done) => setTimeout(done, 60));
    expect(api.pollCloudDevice).toHaveBeenCalledTimes(calls);
    expect(screen.getByRole("button", { name: "New code" })).toBeTruthy();
  });
});
