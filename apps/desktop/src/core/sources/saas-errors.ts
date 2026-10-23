/**
 * Armadra 云控制台类调用（授予、邀请、信任请求，契约 §33.12）的错误收拢。
 *
 * 这几组调用的拒绝本身就是给人看的结论（谁没有权限、团队不让邀请、已是成员……），
 * 码原样透传，页面按码取文案；远程服务的原话不透传。其余码（会话失效、连不上等）
 * 照 `remote-client.ts` 的通用规则处理。
 */

import { type CoreFailure, fail } from "../http/errors";

export const CONSOLE_HOST = "取主机信息";
export const CONSOLE_MEMBERS = "取团队成员";
export const CONSOLE_GRANTS = "管理授予";
export const CONSOLE_INVITE = "发主机邀请";
export const CONSOLE_TRUST = "处理待信任设备";

export const CONSOLE_DURING: ReadonlySet<string> = new Set([
  CONSOLE_HOST,
  CONSOLE_MEMBERS,
  CONSOLE_GRANTS,
  CONSOLE_INVITE,
  CONSOLE_TRUST,
]);

export function consoleRejection(
  code: string,
  details: Record<string, unknown>,
): CoreFailure | undefined {
  switch (code) {
    case "team_role_insufficient":
      return fail("team_role_insufficient", "你的角色不能做这件事");
    case "source_access_denied":
      return fail("source_access_denied", "你不能管理这台主机");
    case "team_policy_denied":
      return fail("team_policy_denied", "团队设置不允许这样做");
    case "guests_disabled":
      return fail("guests_disabled", "这台主机不允许访客");
    case "email_unverified":
      return fail("email_unverified", "先验证邮箱再继续");
    case "member_exists":
      return fail("member_exists", "对方已经是团队成员");
    case "device_untrusted":
      return fail("device_untrusted", "要在已受信的设备上处理");
    case "conflict":
      return fail("conflict", "和现有的授予冲突");
    case "team_deleted":
      return fail("team_deleted", "团队已删除");
    case "bad_request":
      return fail("bad_request", "远程服务不接受这次请求的参数");
    case "not_found":
      return fail("not_found", "远程服务上没有这个对象");
    case "limit_reached":
      return fail(
        "limit_reached",
        "远程服务的上限已到",
        typeof details.quota === "string"
          ? { quota: details.quota, used: details.used, limit: details.limit }
          : undefined,
      );
    default:
      return undefined;
  }
}
