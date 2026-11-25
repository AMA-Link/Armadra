import type { TimelineEntry } from "@/timeline/store";

/**
 * 这条挂起的审批是不是计划审批（core 写在审批条目上的 `card: "plan"`）。
 *
 * 节点头部的「允许 / 拒绝」快捷按钮只靠状态里的 `pendingId`，看不出是哪种卡片：计划
 * 审批不能在没看到计划的情况下一键批准，头部据此改成「跳到卡片」。条目还没到（时间线
 * 没加载）时答 `false`——保持原来的行为；条目与状态帧是同一批 core 事件，实际上几乎
 * 同时到。
 */
export function isPlanApproval(
  entry: Pick<TimelineEntry, "byId"> | undefined,
  pendingId: string | undefined,
): boolean {
  if (entry === undefined || pendingId === undefined) return false;
  const item = entry.byId[`ap:${pendingId}`];
  return item?.kind === "approval" && item.card === "plan";
}
