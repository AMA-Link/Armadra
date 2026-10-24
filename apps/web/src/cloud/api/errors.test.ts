import { ERROR_CODES } from "@armadra/platform-protocol/errors";
import { afterEach, describe, expect, it } from "vitest";

import { usePreferencesStore } from "@/app/preferences-store";
import { MESSAGE_MODULES } from "@/i18n";
import {
  CLOUD_MESSAGE_BY_CODE,
  CloudConsoleError,
  cloudMessage,
  describeFailure,
  isSessionError,
  isTransient,
  needsSupport,
  toCloudError,
} from "./errors";

afterEach(() => usePreferencesStore.getState().setLocale("zh-CN"));

/** 设计 §6.4 表里「控制台会显示」的码，逐个要有自己的一句话。 */
const SHOWN = [
  "credentials_invalid",
  "account_locked",
  "account_disabled",
  "email_taken",
  "email_unverified",
  "mfa_invalid",
  "mfa_expired",
  "device_code_expired",
  "device_code_denied",
  "rate_limited",
  "limit_reached",
  "source_revoked",
  "source_access_denied",
  "link_invalid",
  "link_expired",
  "link_exhausted",
  "link_secret_invalid",
  "invitation_invalid",
  "forbidden",
  "not_found",
  "email_token_invalid",
  "email_token_expired",
  "team_slug_taken",
  "team_role_insufficient",
  "team_last_owner",
  "team_owner_required",
  "team_suspended",
  "team_deleted",
  "team_hosts_online",
  "invitation_expired",
  "invitation_email_mismatch",
  "member_exists",
  "host_registration_disabled",
  "guests_disabled",
  "plan_feature_unavailable",
  "transfer_pending",
  "device_untrusted",
  "link_frozen",
  "team_policy_denied",
  "invitation_revoked",
  "transfer_expired",
  "registrations_paused",
  "operator_mfa_required",
  "password_too_short",
  "password_too_long",
  "password_too_common",
  "password_contains_name",
  "password_breached",
];
const NO_COPY = [
  "unauthenticated",
  "session_expired",
  "session_revoked",
  "anonymous_links_disabled",
];

describe("错误码 → 文案", () => {
  for (const locale of ["zh-CN", "en"] as const)
    it(`${locale}：设计 §6.4 的每个码都有自己的一句话，不是 error.internal`, () => {
      usePreferencesStore.getState().setLocale(locale);
      const internal = cloudMessage("no_such_code");
      for (const code of SHOWN) {
        const text = cloudMessage(code, {
          quota: "hosts",
          retryAfterMs: 120_000,
          email: "a@b.c",
        });
        expect(text, code).toBeTruthy();
        expect(text, code).not.toBe(internal);
        expect(text, code).not.toMatch(/^(error|cloud)\./);
      }
    });

  it("会话码与匿名链接不出文案", () => {
    for (const code of NO_COPY) expect(cloudMessage(code), code).toBeNull();
    expect(describeFailure(new CloudConsoleError("session_expired", 401))).toBe(
      cloudMessage("no_such_code"),
    );
  });

  it("协议注册表里的每个码要么有文案要么明确无文案，没有空串", () => {
    for (const code of ERROR_CODES) {
      const text = cloudMessage(code);
      if (NO_COPY.includes(code)) expect(text).toBeNull();
      else expect(text, code).toBeTruthy();
    }
  });

  it("映射表里的键两种语言都有", () => {
    const messages = MESSAGE_MODULES["cloud-errors"]!;
    for (const key of Object.values(CLOUD_MESSAGE_BY_CODE)) {
      expect(messages["zh-CN"]![key], key).toBeTruthy();
      expect(messages.en![key], key).toBeTruthy();
    }
  });

  it("limit_reached 读 details.quota，认不出用通用句", () => {
    expect(cloudMessage("limit_reached", { quota: "traffic" })).toBe(
      "本月流量已用完，升级后继续",
    );
    expect(cloudMessage("limit_reached", { quota: "x" })).toBe(
      cloudMessage("limit_reached"),
    );
    for (const quota of ["hosts", "members", "guests", "concurrent"])
      expect(cloudMessage("limit_reached", { quota })).toContain("上限");
  });

  it("account_locked 把等待时间折成分钟，邮箱不一致带上邮箱", () => {
    expect(cloudMessage("account_locked", { retryAfterMs: 90_000 })).toBe(
      "尝试次数过多，2 分钟后再试",
    );
    expect(cloudMessage("account_locked")).toBe("尝试次数过多，账号已暂时锁定");
    expect(cloudMessage("invitation_email_mismatch", { email: "a@b.c" })).toBe(
      "用 a@b.c 登录后接受",
    );
  });

  it("联系支持的两个码", () => {
    expect([...SHOWN, ...NO_COPY].filter(needsSupport).sort()).toEqual([
      "account_disabled",
      "team_suspended",
    ]);
  });
});

describe("toCloudError", () => {
  it("带线上错误体的客户端错误（原样在 data 或 data.body）", () => {
    const wire = {
      code: "team_slug_taken",
      message: "后端原话",
      requestId: "r1",
      details: { a: 1 },
    };
    for (const data of [wire, { status: 409, body: wire }]) {
      const error = toCloudError({ status: 409, data, message: "x" });
      expect(error).toMatchObject({
        code: "team_slug_taken",
        status: 409,
        requestId: "r1",
        details: { a: 1 },
      });
    }
    expect(
      isSessionError(
        toCloudError({ status: 401, data: { code: "session_revoked" } }),
      ),
    ).toBe(true);
  });

  it("没有错误体按状态码兜底，网络失败当暂时不可用", () => {
    expect(toCloudError({ status: 429 }).code).toBe("rate_limited");
    expect(toCloudError({ status: 503 }).code).toBe("unavailable");
    expect(toCloudError({ status: 418 }).code).toBe("internal");
    const network = toCloudError(new TypeError("Failed to fetch"));
    expect(network).toMatchObject({ code: "unavailable", status: 0 });
    expect(isTransient(network)).toBe(true);
    expect(isTransient(new CloudConsoleError("forbidden", 403))).toBe(false);
    expect(toCloudError("boom").code).toBe("internal");
  });
});
