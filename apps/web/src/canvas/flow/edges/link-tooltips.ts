import type { CanvasEdgeRole } from "@armadra/shared";

import type { DeliveryMark } from "@/agent/delivery-store";
import { formatRelativeTime } from "@/lib/format";

/** 连线悬停提示的两句话（`board/BoardEdges` 叠在同一个 `<title>` 里）。 */

/**
 * 边上那句悬停提示：最近一次投递的结果与时刻。
 *
 * 结果码原样按码取文案（`i18n/errors.ts` 的码表），拒绝的那一条多说一句为什么
 * ——`refused` 单独看等于什么都没说。没有投递过就没有这句话。
 */
export function deliveryTooltip(
  mark: DeliveryMark | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (mark === undefined) return null;
  const outcome = t(`delivery.outcome.${mark.outcome}`);
  const line = t("delivery.edge.last", {
    outcome,
    time: formatRelativeTime(mark.at),
  });
  return mark.code === undefined
    ? line
    : `${line} · ${t(`error.delivery.${mark.code}`)}`;
}

/**
 * 主从边的那句提示：「主 @a → 从 @b」。
 *
 * 箭头已经说了方向，这句话说的是**谁是谁**：一条线两端的圆角矩形长得一样，
 * 而「planner 盯着 codex-1」与反过来是两件事。对等边没有这句话。
 */
export function supervisionTooltip(
  role: CanvasEdgeRole | undefined,
  supervisor: string,
  subordinate: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (role !== "supervises") return null;
  return t("edge.role.supervises", { supervisor, subordinate });
}
