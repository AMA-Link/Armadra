/**
 * Armadra 云授予的合成（cloud-api §24、#112），分享弹层与云端控制台共用同一套规则，
 * 在提交前提示管理员；真正的合成与拒绝在云端（`go/internal/cloud/grants/effective.go`）。
 *
 * 同一个人的多条授予（团队全员、本人、访客各一条）：范围取并集（任一条整台即整台），
 * 角色取「使范围内每一处都被角色 ≥ 它的来路覆盖」的最高角色（不放大：driver@w1 加 viewer
 * 整台是 viewer 整台），到期取对范围与角色有贡献的来路中最早的非空到期。所以新增一条范围
 * 更宽而角色更低的授予，会降低这个人原有的有效角色；任何收窄（角色降低、范围变小、到期提前）
 * 云端都会撤销他已签的令牌并断开连接。
 */

export const CLOUD_ROLES = ["viewer", "editor", "operator", "driver"] as const;
export type CloudRole = (typeof CLOUD_ROLES)[number];

export interface GrantShape {
  readonly role: CloudRole;
  /** 空 = 整台主机。 */
  readonly workspaceIds: readonly string[];
  readonly expiresAtMs?: number | null;
}

const rank = (role: CloudRole): number => CLOUD_ROLES.indexOf(role);

/** 角色的高低（viewer 0 … driver 3）。 */
export const rankOf = rank;

/** 合成后的有效权限；没有来路时 `role` 是 `null`。 */
export interface ComposedAccess {
  readonly role: CloudRole | null;
  readonly whole: boolean;
  /** `whole` 为假时允许的工作空间（升序去重）。 */
  readonly workspaceIds: readonly string[];
  readonly expiresAtMs: number | null;
}

const NONE: ComposedAccess = {
  role: null,
  whole: false,
  workspaceIds: [],
  expiresAtMs: null,
};

/** 合成一个人对一台主机的有效权限（调用方先滤掉已撤销与已过期的来路，见 {@link liveGrants}）。 */
export function composeAccess(sources: readonly GrantShape[]): ComposedAccess {
  if (sources.length === 0) return NONE;
  const whole = sources.some((one) => one.workspaceIds.length === 0);
  const workspaceIds = [
    ...new Set(sources.flatMap((one) => one.workspaceIds)),
  ].sort();
  let top = -1;
  if (whole) {
    for (const one of sources)
      if (one.workspaceIds.length === 0) top = Math.max(top, rank(one.role));
  } else {
    for (const id of workspaceIds) {
      const best = Math.max(
        ...sources
          .filter((one) => one.workspaceIds.includes(id))
          .map((one) => rank(one.role)),
      );
      top = top < 0 ? best : Math.min(top, best);
    }
  }
  let expiresAtMs: number | null = null;
  for (const one of sources) {
    const contributes = whole
      ? one.workspaceIds.length === 0 && rank(one.role) === top
      : rank(one.role) >= top;
    const until = one.expiresAtMs ?? null;
    if (contributes && until !== null)
      expiresAtMs = expiresAtMs === null ? until : Math.min(expiresAtMs, until);
  }
  return {
    role: CLOUD_ROLES[top] ?? null,
    whole,
    workspaceIds: whole ? [] : workspaceIds,
    expiresAtMs,
  };
}

/** 合成后的角色；没有来路是 `null`。 */
export function composeRole(sources: readonly GrantShape[]): CloudRole | null {
  return composeAccess(sources).role;
}

/** 还没过期的那些。 */
export function liveGrants<T extends { expiresAtMs?: number | null }>(
  grants: readonly T[],
  now: number,
): T[] {
  return grants.filter(
    (one) => one.expiresAtMs == null || one.expiresAtMs > now,
  );
}

/** after 相对 before 是不是收窄：由有变无、角色降低、范围变小或到期提前（云端 `Narrowed`）。 */
export function narrowed(
  before: ComposedAccess,
  after: ComposedAccess,
): boolean {
  if (before.role === null) return false;
  if (after.role === null || rank(after.role) < rank(before.role)) return true;
  if (!after.whole) {
    if (before.whole) return true;
    if (before.workspaceIds.some((id) => !after.workspaceIds.includes(id)))
      return true;
  }
  if (after.expiresAtMs === null) return false;
  if (before.expiresAtMs === null) return true;
  return after.expiresAtMs < before.expiresAtMs;
}

/** 新增这一条之后，这个人的有效角色是否比原来低。 */
export function lowersEffectiveRole(
  existing: readonly GrantShape[],
  added: GrantShape,
  now: number,
): boolean {
  const live = liveGrants(existing, now);
  const before = composeRole(live);
  if (before === null) return false;
  const after = composeRole([...live, added]);
  return after !== null && rank(after) < rank(before);
}

/** 新增、改动或撤销之后，这个人的有效权限是否收窄（角色降低、范围变小或到期提前）。 */
export function narrowsAccess(
  before: readonly GrantShape[],
  after: readonly GrantShape[],
  now: number,
): boolean {
  return narrowed(
    composeAccess(liveGrants(before, now)),
    composeAccess(liveGrants(after, now)),
  );
}

/** 新范围是否比现有的小（整台 → 部分，或丢了某个工作空间）；`next` 为空 = 整台。 */
export function narrowsScope(
  held: readonly string[],
  next: readonly string[],
): boolean {
  if (next.length === 0) return false;
  if (held.length === 0) return true;
  return held.some((id) => !next.includes(id));
}

/** 到期是否提前：`next` 为 `undefined` = 不改；`null` = 永不到期。 */
export function shortensExpiry(
  held: number | null,
  next: number | null | undefined,
): boolean {
  if (next === undefined || next === null) return false;
  return held === null || next < held;
}

/** 改一条授予的新值（`expiresAtMs` 缺省 = 不改）。 */
export interface GrantEdit {
  readonly role: CloudRole;
  readonly workspaceIds: readonly string[];
  readonly expiresAtMs?: number | null;
}

/**
 * 把 `target`（这个人的授予之一）改成 `next` 之后，他的有效权限是否收窄：任一来路角色更低、
 * 范围更小或到期更早，或合成结果收窄。`held` 是他在这台主机上的全部授予（含 `target`）。
 */
export function updateNarrows(
  held: readonly GrantShape[],
  target: GrantShape,
  next: GrantEdit,
  now: number,
): boolean {
  const before = composeRole(liveGrants(held, now));
  if (before !== null && rank(next.role) < rank(before)) return true;
  if (narrowsScope(target.workspaceIds, next.workspaceIds)) return true;
  if (shortensExpiry(target.expiresAtMs ?? null, next.expiresAtMs)) return true;
  const replaced: GrantShape = {
    role: next.role,
    workspaceIds: next.workspaceIds,
    expiresAtMs:
      next.expiresAtMs === undefined
        ? (target.expiresAtMs ?? null)
        : next.expiresAtMs,
  };
  return narrowsAccess(
    held,
    held.map((one) => (one === target ? replaced : one)),
    now,
  );
}
