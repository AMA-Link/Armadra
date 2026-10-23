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
    "share.cloud.title": "Armadra 云",
    "share.cloud.scope.host": "整台主机",
    "share.cloud.member": "成员",
    "share.cloud.member.pick": "选择成员",
    "share.cloud.member.search": "搜索成员",
    "share.cloud.member.none": "没有可授予的成员",
    "share.cloud.guest": "访客",
    "share.cloud.grant": "授予",
    "share.cloud.email": "邮箱",
    "share.cloud.invite": "邀请",
    "share.cloud.granted": "已授予 {name}",
    "share.cloud.granted.list": "已授予",
    "share.cloud.invited": "已邀请 {email}",
    "share.cloud.revoke": "移除 {name}",
    "share.cloud.update": "更新",
    "share.cloud.lowers.update": "权限比 {name} 现有的低，会降低他的有效权限",
    "share.cloud.lowers.invite":
      "范围更宽而权限更低，可能降低 {name} 现有的有效权限，他接受时云端会拒绝",
    "share.cloud.lowers.confirm": "仍要更新",
    "share.cloud.lowers.confirmInvite": "仍要邀请",
    "share.cloud.conflict": "对方在这台主机上已有授予，在已授予里调整",
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
    "share.cloud.title": "Armadra Cloud",
    "share.cloud.scope.host": "Whole computer",
    "share.cloud.member": "Member",
    "share.cloud.member.pick": "Choose a member",
    "share.cloud.member.search": "Search members",
    "share.cloud.member.none": "No members to grant",
    "share.cloud.guest": "Guest",
    "share.cloud.grant": "Grant",
    "share.cloud.email": "Email",
    "share.cloud.invite": "Invite",
    "share.cloud.granted": "Granted {name}",
    "share.cloud.granted.list": "Granted",
    "share.cloud.invited": "Invited {email}",
    "share.cloud.revoke": "Remove {name}",
    "share.cloud.update": "Update",
    "share.cloud.lowers.update":
      "A lower role than {name} has now would lower their effective role",
    "share.cloud.lowers.invite":
      "Wider scope with a lower role may lower {name}'s effective role. The cloud rejects it when they accept",
    "share.cloud.lowers.confirm": "Update anyway",
    "share.cloud.lowers.confirmInvite": "Invite anyway",
    "share.cloud.conflict":
      "They already have a grant on this computer. Adjust it in the list",
  },
};
