import type { MessageModule } from "./index";

/**
 * 画布与工作空间的分享弹层（#301 B5）。链接的列表与管理在设置 → 远程访问
 * （`remote.*`）；这里只有弹层自己的几句。
 */
export const share: MessageModule = {
  "zh-CN": {
    "share.action": "分享",
    "share.title": "分享「{name}」",
    "share.scope.workspace": "此工作空间",
    "share.scope.session": "仅此会话",
    "share.route": "互联网路线",
    "share.signIn": "登录并开启",
    "share.create": "创建链接",
    "share.manage": "管理链接",
    "share.done": "完成",
  },
  en: {
    "share.action": "Share",
    "share.title": "Share “{name}”",
    "share.scope.workspace": "This workspace",
    "share.scope.session": "Only this session",
    "share.route": "Internet route",
    "share.signIn": "Sign in and turn on",
    "share.create": "Create link",
    "share.manage": "Manage links",
    "share.done": "Done",
  },
};
