/**
 * 节点头部对挂起审批的呈现（审批卡自己的种类由 core 写在状态帧的 `pendingCard` 上）。
 *
 * 头部的「允许 / 拒绝」一键按钮只有 `pendingId`，看不出是哪种卡：计划审批不能在没看到
 * 计划的情况下一键批准。所以只要状态帧带了 `pendingCard`（计划审批是 `plan`，以后的卡片
 * 种类页面不认得也一样），就不出一键按钮，换成跳到卡片的按钮。读状态帧、不读时间线：
 * 状态帧与 `pendingId` 同一帧到，没有「时间线还没加载」的窗口；旧页面（不认识这个字段）
 * 的一键按钮由 core 兜底——答计划卡必须显式 `optionId`，裸的 `decision` 会被 400 拒绝。
 */
export type HeaderApproval =
  { readonly kind: "quick" } | { readonly kind: "card"; readonly card: string };

export function headerApprovalOf(
  status: { readonly pendingCard?: string | undefined } | undefined,
): HeaderApproval {
  const card = status?.pendingCard;
  return card === undefined || card === ""
    ? { kind: "quick" }
    : { kind: "card", card };
}
