import type { MessageModule } from "./index";

/**
 * Frame ↔ worktree 绑定（roadmap §3.4 G03）。
 *
 * 键前缀 `frameBinding.`，和仓库面板的 `gitRepo.` 分开：绑定是画布上的东西，
 * 面板只是创建它的入口之一。
 */
export const frameBinding: MessageModule = {
  "zh-CN": {
    "frameBinding.worktree": "Worktree",
    "frameBinding.dirtyCount": "{count} 处未提交变更",
    "frameBinding.dirtyClean": "无未提交变更",
    "frameBinding.dirtyUnknown": "变更数未知（需要工作区执行权限）",
    "frameBinding.initPending": "初始化脚本待运行",
    "frameBinding.initRunning": "初始化脚本运行中",
    "frameBinding.initSucceeded": "初始化脚本已完成",
    "frameBinding.initFailed": "初始化脚本失败",
    // 绑定坏掉的方式不止一种，修法也不一样：目录没了可以重建，分支被切走
    // 了不能——那个检出还在，重建只会失败。
    "frameBinding.reason.missing": "找不到这个 worktree",
    "frameBinding.reason.mismatch": "这个目录已经不属于原来的仓库",
    "frameBinding.reason.branchChanged": "这个 worktree 的分支被切走了",
    "frameBinding.recreate": "重新创建",
    "frameBinding.unbind": "解绑",
    "frameBinding.unbindFrame": "解绑 Frame",
    "frameBinding.createFrame": "同时创建绑定这个 worktree 的 Frame",
    "frameBinding.initScript": "初始化脚本（在新 worktree 里只运行一次）",
    "frameBinding.initTerminalTitle": "初始化脚本",
  },
  en: {
    "frameBinding.worktree": "Worktree",
    "frameBinding.dirtyCount": "{count} uncommitted change(s)",
    "frameBinding.dirtyClean": "No uncommitted changes",
    "frameBinding.dirtyUnknown":
      "Change count unknown (needs an execution grant)",
    "frameBinding.initPending": "Init script pending",
    "frameBinding.initRunning": "Init script running",
    "frameBinding.initSucceeded": "Init script finished",
    "frameBinding.initFailed": "Init script failed",
    "frameBinding.reason.missing": "Worktree not found",
    "frameBinding.reason.mismatch":
      "This directory is no longer that repository",
    "frameBinding.reason.branchChanged": "This worktree switched branch",
    "frameBinding.recreate": "Recreate",
    "frameBinding.unbind": "Unbind",
    "frameBinding.unbindFrame": "Unbind Frame",
    "frameBinding.createFrame": "Also create a Frame bound to this worktree",
    "frameBinding.initScript": "Init script (runs once in the new worktree)",
    "frameBinding.initTerminalTitle": "Init script",
  },
};
