import type { MessageModule } from "./index";

/**
 * 代码托管面板的入口、不可用状态与 GitHub 凭据设置的文案（契约 §5）。面板里的
 * 仓库视图用 `forge.ts` 的键。
 */
const zh = {
  /* 页与入口 */
  "cluster.github": "代码托管",
  "cmd.app.github": "代码托管面板",
  "github.reload": "刷新",
  "github.close": "关闭",

  /* 不可用状态（§9：不出现伪按钮） */
  "github.blocked.noWorkspace": "先打开一个工作空间",
  "github.blocked.nativeSession":
    "桌面壳未能建立本机会话，原因见「设置 → 设备与会话」",
  "github.blocked.disconnected": "连不上 Host",
  "github.blocked.unsupported": "这个 Host 没有 GitHub 服务",
  "github.blocked.noSession": "这个 Host 不支持浏览器会话",
  "github.blocked.signedOut": "这台设备还没有与 Host 配对",
  "github.blocked.noPermission": "这台设备没有该工作空间的 GitHub 权限",
  "github.blocked.noCredential": "Host 现在拿不到可用的 GitHub 凭据",
  "github.blocked.action": "前往设置",
  "github.blocked.credentialAction": "前往设置 → 代码托管",

  /* 仓库 */
  "github.remoteUrl": "远端地址",
  "github.resolve": "解析仓库",
  "github.enterprise": "GitHub Enterprise",

  /* 关联徽标 */
  "github.reference.open": "打开关联的 GitHub 条目",

  /* 失败 */
  "github.error.invalid": "请求参数不合法",
  "github.error.unauthenticated": "Host 拒绝了这次请求：未认证",
  "github.error.permission": "这台设备没有做这件事的权限",
  "github.error.unsupported": "这个 Host 不支持该操作",
  "github.error.notFound": "远端上找不到这个对象",
  "github.error.conflict": "远端已经变了，刷新后重试",
  "github.error.rateLimited": "已被限流，等配额恢复",
  "github.error.response": "Host 的回应无法解析",
  "github.error.cancelled": "请求已取消",
  "github.error.network": "连不上 Host",
  "github.error.unknownOutcome": "请求已发出但结果未知，刷新后核对远端状态",

  /* 设置 → GitHub */
  "github.settings.source": "凭据来源",
  "github.settings.apiBase": "API 地址",
  "github.settings.token": "个人访问令牌",
  "github.settings.save": "保存",
  "github.settings.revoke": "撤销凭据",
  "github.settings.available": "可用",
  "github.settings.unavailable": "不可用",
  "github.source.none": "不配置",
  "github.source.ghCli": "复用本机 gh 登录",
  "github.source.token": "粘贴令牌",
  "github.store.fileFallback": "0600 文件（降级）",
} as const;

const en: Record<keyof typeof zh, string> = {
  "cluster.github": "Code hosting",
  "cmd.app.github": "Code hosting panel",
  "github.reload": "Reload",
  "github.close": "Close",

  "github.blocked.noWorkspace": "Open a workspace first",
  "github.blocked.nativeSession":
    "The desktop shell could not open a local session; see Settings → Devices & sessions",
  "github.blocked.disconnected": "Cannot reach the Host",
  "github.blocked.unsupported": "This Host has no GitHub service",
  "github.blocked.noSession": "This Host does not support browser sessions",
  "github.blocked.signedOut": "This device is not paired with the Host",
  "github.blocked.noPermission":
    "This device has no GitHub permission for this workspace",
  "github.blocked.noCredential":
    "The Host cannot produce a usable GitHub credential",
  "github.blocked.action": "Open Settings",
  "github.blocked.credentialAction": "Go to Settings → Code hosting",

  "github.remoteUrl": "Remote URL",
  "github.resolve": "Resolve repository",
  "github.enterprise": "GitHub Enterprise",

  "github.reference.open": "Open the linked GitHub item",

  "github.error.invalid": "The request arguments are not valid",
  "github.error.unauthenticated":
    "The Host refused the request: unauthenticated",
  "github.error.permission": "This device may not do that",
  "github.error.unsupported": "This Host does not support that operation",
  "github.error.notFound": "The remote has no such object",
  "github.error.conflict": "The remote already changed; reload and retry",
  "github.error.rateLimited": "Throttled; wait for the quota to recover",
  "github.error.response": "The Host's answer could not be read",
  "github.error.cancelled": "The request was cancelled",
  "github.error.network": "Cannot reach the Host",
  "github.error.unknownOutcome":
    "The request was sent but its result is unknown; reload and check the remote",
  "github.settings.source": "Credential source",
  "github.settings.apiBase": "API address",
  "github.settings.token": "Personal access token",
  "github.settings.save": "Save",
  "github.settings.revoke": "Revoke credential",
  "github.settings.available": "Available",
  "github.settings.unavailable": "Unavailable",
  "github.source.none": "None",
  "github.source.ghCli": "Reuse the local gh login",
  "github.source.token": "Paste a token",
  "github.store.fileFallback": "0600 file (degraded)",
};

export const github: MessageModule = { "zh-CN": zh, en };
