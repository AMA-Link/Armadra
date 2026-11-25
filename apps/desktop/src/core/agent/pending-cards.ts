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

/** 序列化时展开用：有登记就是 `{ pendingCard }`，没有是空对象。 */
export function pendingCardField(pendingId: string | null | undefined): {
  pendingCard?: string;
} {
  const card = pendingCardOf(pendingId);
  return card === undefined ? {} : { pendingCard: card };
}

/**
 * 节点头部要常驻显示的一句终端卡提示（契约 §127）：
 *
 *   * `unconfirmed` / `mismatch` / `ambiguous`：在终端卡上按了键，没有被看到生效；
 *     留到这一回合结束。
 *   * `unverified_version` / `mode_excluded`：设置开着，但这张卡没有建审批记录，
 *     原因是 grok 版本不在已验证清单里、或节点不是 `auto-edit` / `plan` 启动的；
 *     留到这张卡结案。
 *
 * 同样只在内存里，状态帧序列化时按节点 id 查，不进数据库。
 */
export type CardNotice =
  | "unconfirmed"
  | "mismatch"
  | "ambiguous"
  | "not_sent"
  | "unverified_version"
  | "mode_excluded";

const notices = new Map<string, CardNotice>();

export function setCardNotice(nodeId: string, notice: CardNotice): void {
  notices.set(nodeId, notice);
}

export function clearCardNotice(nodeId: string): void {
  notices.delete(nodeId);
}

export function cardNoticeOf(nodeId: string): CardNotice | undefined {
  return notices.get(nodeId);
}

/** 状态帧上与卡片有关的两个字段：`pendingCard`（按 pendingId）与 `cardNotice`（按节点）。 */
export function cardFields(
  pendingId: string | null | undefined,
  nodeId: string,
): { pendingCard?: string; cardNotice?: CardNotice } {
  const notice = cardNoticeOf(nodeId);
  return {
    ...pendingCardField(pendingId),
    ...(notice === undefined ? {} : { cardNotice: notice }),
  };
}
