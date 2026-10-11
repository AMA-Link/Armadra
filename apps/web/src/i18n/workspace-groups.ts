import type { MessageModule } from "./index";

/**
 * 侧栏的三组与他人分享的标识（#301）：这台电脑、我的其他电脑、他人分享；
 * 分享来的工作空间带主人与权限，画布顶栏写「<主人> 的 <工作空间>」。
 */
export const workspaceGroups: MessageModule = {
  "zh-CN": {
    "workspaceGroups.local": "这台电脑",
    "workspaceGroups.mine": "我的其他电脑",
    "workspaceGroups.shared": "他人分享",
    "workspaceGroups.role.viewer": "只读",
    "workspaceGroups.role.editor": "可编辑",
    "workspaceGroups.role.operator": "可执行",
    "workspaceGroups.role.driver": "可接管",
    "workspaceGroups.ownerWorkspace": "{owner} 的 {workspace}",
    "workspaceGroups.members": "在线成员",
  },
  en: {
    "workspaceGroups.local": "This computer",
    "workspaceGroups.mine": "My other computers",
    "workspaceGroups.shared": "Shared with me",
    "workspaceGroups.role.viewer": "View only",
    "workspaceGroups.role.editor": "Can edit",
    "workspaceGroups.role.operator": "Can run",
    "workspaceGroups.role.driver": "Full control",
    "workspaceGroups.ownerWorkspace": "{owner}'s {workspace}",
    "workspaceGroups.members": "Online members",
  },
};
