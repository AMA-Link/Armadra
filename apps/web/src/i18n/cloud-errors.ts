import type { MessageModule } from "./index";

/**
 * 云端控制台的错误文案（云端控制台 §6.4）：只放协议 1.4 新增、或控制台要换一句话的码。
 * 码到键的映射在 `cloud/api/errors.ts`；`limit_reached` 的 `cloud.billing.limit.*` 随
 * 配额一起放在这里，用量页（U6）直接引用。
 */
export const cloudErrors: MessageModule = {
  "zh-CN": {
    "cloud.auth.locked": "尝试次数过多，{minutes} 分钟后再试",
    "error.accountDisabled": "账号已停用，联系支持",
    "error.emailTaken": "这个邮箱已注册，直接登录",
    "error.emailUnverified": "先验证邮箱再继续",
    "error.mfaInvalid": "验证码不正确，重新输入",
    "error.mfaExpired": "验证已超时，重新登录",
    "error.deviceCodeExpired": "设备码已过期，回到设备上重新获取",
    "error.deviceCodeDenied": "已拒绝这次登录",
    "error.emailTokenInvalid": "链接无效或已用过，重新获取",
    "error.emailTokenExpired": "链接已过期，重新获取",
    "error.teamSlugTaken": "地址已被占用，换一个",
    "error.teamRoleInsufficient": "你的角色不能做这件事，联系团队管理员",
    "error.teamLastOwner": "先把所有权转给另一位管理员",
    "error.teamOwnerRequired": "先转移你名下团队的所有权",
    "error.teamSuspended": "团队已停用，联系支持",
    "error.teamDeleted": "团队已删除，所有者可在 30 天内恢复",
    "error.invitationExpired": "邀请已过期，请对方重新邀请",
    "error.invitationEmailMismatch": "用 {email} 登录后接受",
    "error.memberExists": "已是团队成员",
    "error.hostRegistrationDisabled": "团队不允许成员登记主机，联系管理员",
    "error.guestsDisabled": "团队不允许访客，在设置里开启",
    "error.planFeatureUnavailable": "当前计划不含这项功能，升级后可用",
    "error.transferPending": "这台主机已有待接受的移动",
    "cloud.trust.useTrusted": "在已信任的设备上处理",
    "error.linkFrozen": "链接已冻结，联系分享的人",
    "error.teamPolicyDenied": "团队设置不允许这样做，联系管理员",
    "error.invitationRevoked": "邀请已撤销，请对方重新邀请",
    "error.transferExpired": "移动请求已过期，重新发起",
    "cloud.auth.registrationsClosed": "暂停注册",
    "error.operatorMfaRequired": "运营账号要先开启两步验证",
    "cloud.billing.limit.hosts": "主机数已达上限，升级或撤销一台主机",
    "cloud.billing.limit.members": "成员数已达上限，升级或移除一位成员",
    "cloud.billing.limit.guests": "访客数已达上限，升级或移除一位访客",
    "cloud.billing.limit.concurrent": "同时连接已达上限，关掉一个连接后重试",
    "cloud.billing.limit.traffic": "本月流量已用完，升级后继续",
    "cloud.billing.limit.teams": "免费版只能建一个团队，升级后再建",
  },
  en: {
    "cloud.auth.locked": "Too many attempts. Try again in {minutes} min",
    "error.accountDisabled": "Account suspended. Contact support",
    "error.emailTaken": "This email is registered. Sign in instead",
    "error.emailUnverified": "Verify your email to continue",
    "error.mfaInvalid": "Incorrect code. Try again",
    "error.mfaExpired": "Verification timed out. Sign in again",
    "error.deviceCodeExpired": "Code expired. Get a new one on your device",
    "error.deviceCodeDenied": "This sign-in was declined",
    "error.emailTokenInvalid":
      "This link is invalid or used. Request a new one",
    "error.emailTokenExpired": "This link expired. Request a new one",
    "error.teamSlugTaken": "This URL is taken. Try another",
    "error.teamRoleInsufficient": "Your role can't do this. Ask a team admin",
    "error.teamLastOwner": "Transfer ownership to another admin first",
    "error.teamOwnerRequired": "Transfer ownership of your teams first",
    "error.teamSuspended": "This team is suspended. Contact support",
    "error.teamDeleted":
      "Team deleted. The owner can restore it within 30 days",
    "error.invitationExpired": "Invitation expired. Ask for a new one",
    "error.invitationEmailMismatch": "Sign in as {email} to accept",
    "error.memberExists": "Already a member",
    "error.hostRegistrationDisabled":
      "Members can't register hosts here. Ask an admin",
    "error.guestsDisabled": "Guests are off. Turn them on in settings",
    "error.planFeatureUnavailable": "Not in your plan. Upgrade to use it",
    "error.transferPending": "This host already has a pending move",
    "cloud.trust.useTrusted": "Use a trusted device",
    "error.linkFrozen": "This link is frozen. Contact the person who shared it",
    "error.teamPolicyDenied": "Team settings don't allow this. Ask an admin",
    "error.invitationRevoked": "Invitation revoked. Ask for a new one",
    "error.transferExpired": "This move expired. Start it again",
    "cloud.auth.registrationsClosed": "Sign-ups are paused",
    "error.operatorMfaRequired":
      "Turn on two-step verification for this operator account first",
    "cloud.billing.limit.hosts": "Host limit reached. Upgrade or revoke a host",
    "cloud.billing.limit.members":
      "Member limit reached. Upgrade or remove a member",
    "cloud.billing.limit.guests":
      "Guest limit reached. Upgrade or remove a guest",
    "cloud.billing.limit.concurrent":
      "Connection limit reached. Close a connection and try again",
    "cloud.billing.limit.traffic":
      "Monthly traffic used up. Upgrade to continue",
    "cloud.billing.limit.teams":
      "Free plan allows one team. Upgrade to create more",
  },
};
