import type { MessageModule } from "./index";

/**
 * 工作空间的添加 / 归档（§20 →§27，契约 §65、§89）：侧栏「添加项目」对话框的
 * 三种来源（仓库、本地、地址）与工作空间行菜单的归档及其撤销提示。
 *
 * 模块名保留 `launcher` 以免键名整体搬家。
 */
export const launcher: MessageModule = {
  "zh-CN": {
    "launcher.archive": "归档",
    "launcher.archived": "已归档「{name}」",
    "launcher.undo": "撤销",

    "folder.parent": "父目录",
    "folder.choose": "选择",

    "clone.url": "仓库地址",
    "clone.start": "克隆",
    "clone.progress": "克隆进度",

    "newWorkspace.repository": "仓库",
    "newWorkspace.local": "本地",
    "newWorkspace.url": "地址",
    "newWorkspace.search": "搜索仓库",
    "newWorkspace.notConnected": "未连接代码托管账号",
    "newWorkspace.account": "账号",
    "newWorkspace.noRepositories": "没有仓库",
    "newWorkspace.private": "私有",
    "newWorkspace.open": "打开",
  },
  en: {
    "launcher.archive": "Archive",
    "launcher.archived": "Archived “{name}”",
    "launcher.undo": "Undo",

    "folder.parent": "Parent folder",
    "folder.choose": "Choose",

    "clone.url": "Repository URL",
    "clone.start": "Clone",
    "clone.progress": "Clone progress",

    "newWorkspace.repository": "Repository",
    "newWorkspace.local": "Local",
    "newWorkspace.url": "URL",
    "newWorkspace.search": "Search repositories",
    "newWorkspace.notConnected": "No code host account connected",
    "newWorkspace.account": "Account",
    "newWorkspace.noRepositories": "No repositories",
    "newWorkspace.private": "Private",
    "newWorkspace.open": "Open",
  },
};
