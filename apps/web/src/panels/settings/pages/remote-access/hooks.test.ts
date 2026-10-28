import { describe, expect, it } from "vitest";

import type { RemoteService } from "../../../../api/remote-services";
import { canShare, canStartRoute } from "./hooks";

const base: RemoteService = {
  serviceId: "svc",
  kind: "personal",
  issuer: "https://relay.test",
  label: "relay.test",
  defaultLabel: "relay.test",
  accountHint: "ada",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: false,
  hasCredentials: true,
  guest: false,
};

describe("canShare / canStartRoute（契约 §88.4）", () => {
  it("个人中转：登录着、有账号名；访客与没登录的不行", () => {
    expect(canShare(base)).toBe(true);
    expect(canStartRoute(base)).toBe(true);
    expect(canShare({ ...base, guest: true })).toBe(false);
    expect(canShare({ ...base, hasCredentials: false })).toBe(false);
    expect(canShare({ ...base, accountHint: "" })).toBe(false);
  });

  it("Armadra 云：本机已登记且登录着才能分享；路线不从这里一键开", () => {
    const saas = { ...base, kind: "saas" as const, accountHint: "" };
    expect(canShare(saas)).toBe(false);
    expect(canShare({ ...saas, registered: true })).toBe(true);
    expect(canShare({ ...saas, registered: true, hasCredentials: false })).toBe(
      false,
    );
    expect(canStartRoute({ ...saas, registered: true })).toBe(false);
  });
});
