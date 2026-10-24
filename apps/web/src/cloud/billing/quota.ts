import type { ProgressTone } from "@/ui/progress";

/** 控制台用量页展示的配额，按此顺序（`teams` 只在个人空间有意义）。 */
export const QUOTA_ORDER = [
  "hosts",
  "members",
  "guests",
  "concurrent",
  "traffic",
] as const;

export type QuotaMetric = (typeof QUOTA_ORDER)[number];

export type QuotaLevel = "ok" | "near" | "full";

/** 已用占上限的比例；不限（`limit === null`）或上限为 0 没有比例。 */
export function quotaPercent(value: number, limit: number | null) {
  return limit === null || limit <= 0 ? null : (value / limit) * 100;
}

/** ≥ 80% 接近上限，≥ 100% 已达上限（云端控制台 §3.3.11）。 */
export function quotaLevel(percent: number | null): QuotaLevel {
  if (percent === null) return "ok";
  if (percent >= 100) return "full";
  return percent >= 80 ? "near" : "ok";
}

export const QUOTA_TONE: Readonly<Record<QuotaLevel, ProgressTone>> = {
  ok: "brand",
  near: "warn",
  full: "danger",
};
