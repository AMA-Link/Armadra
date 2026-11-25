/**
 * 挂起的审批里哪些是「计划审批」（`holdExt` 挂的，core 自己写的 `card: "plan"`）。
 *
 * 状态行只有 `pendingId`，节点头部的一键允许 / 拒绝据此出按钮——看不出哪一种卡。计划审批
 * 不能在没看到计划的情况下一键批准，所以状态帧也要带上它（`pendingCard`）。这张表只在内存
 * 里：会话挂卡时登记、结算时撤掉；状态帧在序列化时按 `pendingId` 查（`hook/store.ts`、
 * `agent/status.ts`），不进数据库、不需要迁移。进程重启后审批本身也不在了。
 */
const cards = new Map<string, string>();

export function notePendingCard(pendingId: string, card: string): void {
  cards.set(pendingId, card);
}

export function forgetPendingCard(pendingId: string): void {
  cards.delete(pendingId);
}

/** 这条挂起的审批的卡片种类；普通审批、没有 `pendingId` 答 `undefined`。 */
export function pendingCardOf(
  pendingId: string | null | undefined,
): string | undefined {
  return pendingId === null || pendingId === undefined
    ? undefined
    : cards.get(pendingId);
}
