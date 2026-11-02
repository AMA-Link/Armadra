import { describe, expect, it } from "vitest";

import { messages } from "@/i18n";
import { RuntimeRequestError } from "@/api/request";
import { startFailureKey, startFailureNote } from "./start-failure";

describe("startFailureKey", () => {
  it.each([
    ["acp_auth_required", "acp.error.authRequired"],
    ["acp_not_installed", "acp.error.notInstalled"],
    ["acp_mode_unavailable", "acp.error.modeUnavailable"],
    ["acp_mode_unsupported", "acp.error.modeUnavailable"],
    ["acp_protocol_version", "acp.error.protocolVersion"],
    ["acp_session_timeout", "acp.error.timeout"],
    ["acp_cli_outdated", "acp.error.cliOutdated"],
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
      "acp_cli_outdated",
      "other",
    ]) {
      const key = startFailureKey(code);
      expect(messages["zh-CN"][key], key).toBeTruthy();
      expect(messages.en[key], key).toBeTruthy();
    }
  });
});

describe("startFailureNote", () => {
  const t = (key: string, values?: Record<string, string | number>) =>
    `${key}:${JSON.stringify(values ?? {})}`;

  it("acp_cli_outdated 写出已装版本、最低版本与应装的包", () => {
    const error = new RuntimeRequestError(409, "old", "acp_cli_outdated", {
      code: "acp_cli_outdated",
      message: "old",
      details: {
        agentId: "pi",
        installed: "0.73.1",
        minimum: "0.81.0",
        package: "@earendil-works/pi-coding-agent",
      },
    });
    expect(startFailureNote(error, t)).toBe(
      'acp.error.cliOutdatedNeed:{"installed":"0.73.1","minimum":"0.81.0","package":"@earendil-works/pi-coding-agent"}',
    );
  });

  it("details 缺失或形状不对时不附", () => {
    const error = new RuntimeRequestError(409, "old", "acp_cli_outdated", {
      details: { installed: 1 },
    });
    expect(startFailureNote(error, t)).toBeNull();
  });

  it("通用文案的码附上 core 转述的原话，并截断", () => {
    const said = new RuntimeRequestError(
      502,
      "Could not start pi: executable not found",
      "acp_session_failed",
    );
    expect(startFailureNote(said, t)).toBe(
      "Could not start pi: executable not found",
    );
    const long = new RuntimeRequestError(502, "x".repeat(900), "acp_exited");
    expect(startFailureNote(long, t)?.length).toBe(300);
  });

  it("有专门一句的码、空原话与非请求错误不附", () => {
    expect(
      startFailureNote(
        new RuntimeRequestError(504, "slow", "acp_session_timeout"),
        t,
      ),
    ).toBeNull();
    expect(
      startFailureNote(
        new RuntimeRequestError(502, "  ", "acp_session_failed"),
        t,
      ),
    ).toBeNull();
    expect(startFailureNote(new Error("boom"), t)).toBeNull();
  });
});
