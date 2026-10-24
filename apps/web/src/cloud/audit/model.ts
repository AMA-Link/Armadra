/** 审计页的筛选与动作分类（云端控制台 §3.3.10）。 */
export const RANGES = ["24h", "7d", "30d", "90d"] as const;
export type AuditRange = (typeof RANGES)[number];
export const DEFAULT_RANGE: AuditRange = "7d";

const HOUR = 3_600_000;
export const RANGE_MS: Readonly<Record<AuditRange, number>> = {
  "24h": 24 * HOUR,
  "7d": 7 * 24 * HOUR,
  "30d": 30 * 24 * HOUR,
  "90d": 90 * 24 * HOUR,
};

/** 动作名的前缀分类（`grant.create` → `grant`）；筛选「类型」按它发 `action=<类型>.`。 */
export const ACTION_TYPES = [
  "member",
  "invitation",
  "host",
  "grant",
  "access",
  "link",
  "team",
  "trust",
  "assertion",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface AuditFilters {
  readonly range: AuditRange;
  readonly actor?: string;
  readonly host?: string;
  readonly type?: ActionType;
}

const HOST_ID = /^[0-9a-f]{32}$/;
const ACTOR_MAX = 128;

/** 地址里的筛选；不合法的值丢掉（回到缺省），不把它们发给云端。 */
export function filtersOf(query: URLSearchParams): AuditFilters {
  const range = query.get("range");
  const type = query.get("type");
  const actor = query.get("actor");
  const host = query.get("host");
  return {
    range: RANGES.find((value) => value === range) ?? DEFAULT_RANGE,
    ...(actor && actor.length <= ACTOR_MAX ? { actor } : {}),
    ...(host && HOST_ID.test(host) ? { host } : {}),
    ...(ACTION_TYPES.some((value) => value === type)
      ? { type: type as ActionType }
      : {}),
  };
}
