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
    ["acp_cwd_missing", "acp.error.cwdMissing"],
    ["pi_outdated", "acp.error.piOutdated"],
    ["pi_missing", "acp.error.piMissing"],
    ["pi_no_model", "acp.error.piNoModel"],
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
      "acp_cwd_missing",
      "pi_outdated",
      "pi_missing",
      "pi_no_model",
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

  it("acp_cli_outdated 没有包时写出 CLI 自己的升级命令；两样都没有就不附", () => {
    const update = new RuntimeRequestError(409, "old", "acp_cli_outdated", {
      details: {
        agentId: "tool",
        installed: "1.0.0",
        minimum: "1.2.0",
        updateCommand: "tool update",
      },
    });
    expect(startFailureNote(update, t)).toBe(
      'acp.error.cliOutdatedUpdate:{"installed":"1.0.0","minimum":"1.2.0","command":"tool update"}',
    );
    const bare = new RuntimeRequestError(409, "old", "acp_cli_outdated", {
      details: { agentId: "tool", installed: "1.0.0", minimum: "1.2.0" },
    });
    expect(startFailureNote(bare, t)).toBeNull();
  });

  it("pi_outdated 同样写出版本与包；pi_missing 只写应装的包", () => {
    const outdated = new RuntimeRequestError(409, "old", "pi_outdated", {
      details: {
        agentId: "pi",
        installed: "1.0.4",
        minimum: "1.1.0",
        package: "pkg",
      },
    });
    expect(startFailureNote(outdated, t)).toBe(
      'acp.error.cliOutdatedNeed:{"installed":"1.0.4","minimum":"1.1.0","package":"pkg"}',
    );
    const missing = new RuntimeRequestError(409, "gone", "pi_missing", {
      details: { package: "pkg" },
    });
    expect(startFailureNote(missing, t)).toBe("pkg");
    expect(
      startFailureNote(new RuntimeRequestError(409, "x", "pi_no_model"), t),
    ).toBeNull();
  });

  it("acp_cwd_missing 写出不存在的目录（#984）", () => {
    const error = new RuntimeRequestError(409, "gone", "acp_cwd_missing", {
      code: "acp_cwd_missing",
      message: "working directory does not exist: /work/gone",
      details: { cwd: "/work/gone" },
    });
    expect(startFailureNote(error, t)).toBe("/work/gone");
    const bare = new RuntimeRequestError(409, "gone", "acp_cwd_missing", {
      code: "acp_cwd_missing",
      message: "gone",
    });
    expect(startFailureNote(bare, t)).toBeNull();
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
