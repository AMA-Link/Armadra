import { describe, expect, it } from "vitest";

import { messages } from "@/i18n";
import { startFailureKey } from "./start-failure";

describe("startFailureKey", () => {
  it.each([
    ["acp_auth_required", "acp.error.authRequired"],
    ["acp_not_installed", "acp.error.notInstalled"],
    ["acp_mode_unavailable", "acp.error.modeUnavailable"],
    ["acp_mode_unsupported", "acp.error.modeUnavailable"],
    ["acp_protocol_version", "acp.error.protocolVersion"],
    ["acp_session_timeout", "acp.error.timeout"],
  ])("%s 有专门的一句", (code, key) => {
    expect(startFailureKey(code)).toBe(key);
  });

  it("没有码或认不出的码落到通用文案", () => {
    expect(startFailureKey(null)).toBe("acp.error.start");
    expect(startFailureKey(undefined)).toBe("acp.error.start");
    expect(startFailureKey("acp_session_failed")).toBe("acp.error.start");
  });

  it("每个键中英都有", () => {
    for (const code of [
      "acp_auth_required",
      "acp_not_installed",
      "acp_mode_unavailable",
      "acp_protocol_version",
      "acp_session_timeout",
      "other",
    ]) {
      const key = startFailureKey(code);
      expect(messages["zh-CN"][key], key).toBeTruthy();
      expect(messages.en[key], key).toBeTruthy();
    }
  });
});
