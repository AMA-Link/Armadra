import type { MessageModule } from "./index";

/**
 * 工作空间的添加 / 移除（§20 →§27，契约 §65）：侧栏「添加项目」对话框的三种
 * 来源（仓库、本地、地址）与工作空间行菜单的移除确认。
 *
 * 模块名保留 `launcher` 以免键名整体搬家。
 */
export const launcher: MessageModule = {
  "zh-CN": {
    "launcher.remove": "从列表移除",
    "launcher.removeTitle": "移除工作空间？",
    "launcher.removeNote": "不会删除磁盘文件",
    "launcher.removeConfirm": "移除",
    "launcher.cancel": "取消",

    "folder.parent": "父目录",
    "folder.choose": "选择",

    "clone.url": "仓库地址",
    "clone.start": "克隆",
    "clone.progress": "克隆进度",

    "newWorkspace.repository": "仓库",
    "newWorkspace.local": "本地",
    "newWorkspace.url": "地址",
    "newWorkspace.search": "搜索仓库",
    "newWorkspace.loading": "正在加载仓库",
    "newWorkspace.notConnected": "未连接 GitHub",
    "newWorkspace.noRepositories": "没有仓库",
    "newWorkspace.private": "私有",
    "newWorkspace.open": "打开",
  },
  en: {
    "launcher.remove": "Remove from list",
    "launcher.removeTitle": "Remove workspace?",
    "launcher.removeNote": "Files on disk are not deleted",
    "launcher.removeConfirm": "Remove",
    "launcher.cancel": "Cancel",

    "folder.parent": "Parent folder",
    "folder.choose": "Choose",

    "clone.url": "Repository URL",
    "clone.start": "Clone",
    "clone.progress": "Clone progress",

    "newWorkspace.repository": "Repository",
    "newWorkspace.local": "Local",
    "newWorkspace.url": "URL",
    "newWorkspace.search": "Search repositories",
    "newWorkspace.loading": "Loading repositories",
    "newWorkspace.notConnected": "GitHub not connected",
    "newWorkspace.noRepositories": "No repositories",
    "newWorkspace.private": "Private",
    "newWorkspace.open": "Open",
  },
};
