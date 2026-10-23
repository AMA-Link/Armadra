import type { MessageModule } from "./index";
export const gitIntegration: MessageModule = {
  "zh-CN": {
    "gitRepo.startCherryPick": "择取提交",
    "gitRepo.skipIntegration": "跳过空提交",
    "gitRepo.skipReplayedCommit": "跳过这个提交",
    "gitIntegration.cherryPick": "Cherry-pick · 择取提交",
    "gitIntegration.commitOid": "来源提交 OID",
    "gitIntegration.fullOid": "完整的提交对象 ID",
    "gitIntegration.mainline": "主线父提交",
    "gitIntegration.chooseMainline": "选择作为比较基础的父提交",
    "gitIntegration.pickDiff": "本次将应用的差异",
    "gitIntegration.emptyPreview":
      "该提交相对所选基础没有文件差异；Git 会停下等待你明确处理空结果。",
    "gitIntegration.recordOrigin": "在提交信息中记录来源 OID",
    "gitIntegration.pickReady": "冲突结果已暂存，可明确继续并创建择取提交。",
    "gitIntegration.emptyPick":
      "当前择取结果为空，不会自动创建或丢弃提交。可以明确跳过，或中止本次操作。",
    "gitIntegration.continueMerge": "继续并提交合并",
    "gitIntegration.abortMerge": "中止合并",
    "gitIntegration.continuePick": "继续择取提交",
    "gitIntegration.abortPick": "中止择取",
    "gitIntegration.continueRevert": "继续并提交回退",
    "gitIntegration.abortRevert": "中止回退",

    "gitRepo.startMerge": "开始合并",
    "gitRepo.startRebase": "开始变基",
    "gitIntegration.rebaseReady": "冲突结果已暂存，可继续重放剩余提交。",
    "gitIntegration.continueRebase": "继续变基",
    "gitIntegration.abortRebase": "中止变基",
    "gitRepo.continueIntegration": "继续 Git 操作",
    "gitRepo.abortIntegration": "中止 Git 操作",
    "gitRepo.state.awaitingResolution": "等待解决或确认提交",
    "gitIntegration.pending": "合并已准备好，仍待你确认提交。",
    "gitIntegration.stageFirst":
      "在编辑器中解决冲突并保存，再到“更改”页暂存；保存文件不会自动标记为已解决。",
    "gitIntegration.external":
      "无法确认此 Git 操作属于当前 Armadra 进程。可以查看冲突，请使用发起操作的 Git 工具继续或中止。",
    "gitIntegration.changed": "仓库或操作已变化，请刷新并重新确认。",
    "gitIntegration.kind.merge": "Merge",
    "gitIntegration.kind.rebase": "Rebase",
    "gitIntegration.kind.cherryPick": "Cherry-pick",
    "gitIntegration.kind.revert": "Revert",
    "gitIntegration.kind.bisect": "Bisect",
    "gitIntegration.kind.unknown": "外部 Git 操作",
  },
  en: {
    "gitRepo.startCherryPick": "Cherry-pick commit",
    "gitRepo.skipIntegration": "Skip empty commit",
    "gitRepo.skipReplayedCommit": "Skip this commit",
    "gitIntegration.cherryPick": "Cherry-pick a commit",
    "gitIntegration.commitOid": "Source commit OID",
    "gitIntegration.fullOid": "Full commit object ID",
    "gitIntegration.mainline": "Mainline parent",
    "gitIntegration.chooseMainline":
      "Choose the parent used as the comparison base",
    "gitIntegration.pickDiff": "Changes to apply",
    "gitIntegration.emptyPreview":
      "This commit has no file difference from the chosen base. Git will stop for an explicit decision about the empty result.",
    "gitIntegration.recordOrigin":
      "Record the source OID in the commit message",
    "gitIntegration.pickReady":
      "The resolved changes are staged. Explicitly continue to create the cherry-picked commit.",
    "gitIntegration.emptyPick":
      "This cherry-pick has an empty result. No commit is created or dropped automatically. Explicitly skip it or abort this operation.",
    "gitIntegration.continueMerge": "Continue and commit merge",
    "gitIntegration.abortMerge": "Abort merge",
    "gitIntegration.continuePick": "Continue cherry-pick",
    "gitIntegration.abortPick": "Abort cherry-pick",
    "gitIntegration.continueRevert": "Continue and commit revert",
    "gitIntegration.abortRevert": "Abort revert",

    "gitRepo.startMerge": "Start merge",
    "gitRepo.startRebase": "Start rebase",
    "gitIntegration.rebaseReady":
      "The resolved changes are staged. Continue to replay the remaining commits.",
    "gitIntegration.continueRebase": "Continue rebase",
    "gitIntegration.abortRebase": "Abort rebase",
    "gitRepo.continueIntegration": "Continue Git operation",
    "gitRepo.abortIntegration": "Abort Git operation",
    "gitRepo.state.awaitingResolution":
      "Awaiting resolution or commit confirmation",
    "gitIntegration.pending":
      "The merge is ready and still awaits your commit confirmation.",
    "gitIntegration.stageFirst":
      "Resolve and save files in the editor, then stage them on Changes. Saving a file does not automatically mark it resolved.",
    "gitIntegration.external":
      "This Git operation cannot be verified as owned by the current Armadra process. You can inspect conflicts; continue or abort using the Git tool that started it.",
    "gitIntegration.changed":
      "The repository or operation changed. Refresh and confirm again.",
    "gitIntegration.kind.merge": "Merge",
    "gitIntegration.kind.rebase": "Rebase",
    "gitIntegration.kind.cherryPick": "Cherry-pick",
    "gitIntegration.kind.revert": "Revert",
    "gitIntegration.kind.bisect": "Bisect",
    "gitIntegration.kind.unknown": "External Git operation",
  },
};
