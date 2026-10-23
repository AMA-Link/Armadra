/**
 * Armadra 云授予的合成（cloud-api §24、#112），分享弹层在提交前用它提示管理员。
 *
 * 同一个人的多条授予：范围取并集（任一条整台即整台），角色取「使范围内每一处都被角色
 * ≥ 它的来路覆盖」的最高角色（不放大：driver@w1 加 viewer 整台是 viewer 整台）。
 * 所以新增一条范围更宽而角色更低的授予，会降低这个人原有的有效角色。真正的合成与拒绝
 * 在云端，这里只是同一条规则的预判。
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

/** 合成后的角色；没有来路是 `null`。 */
export function composeRole(sources: readonly GrantShape[]): CloudRole | null {
  if (sources.length === 0) return null;
  const whole = sources.some((one) => one.workspaceIds.length === 0);
  const union = new Set(sources.flatMap((one) => one.workspaceIds));
  for (let index = CLOUD_ROLES.length - 1; index >= 0; index -= 1) {
    const role = CLOUD_ROLES[index] as CloudRole;
    const covering = sources.filter((one) => rank(one.role) >= index);
    const covered = new Set(covering.flatMap((one) => one.workspaceIds));
    const ok = whole
      ? covering.some((one) => one.workspaceIds.length === 0)
      : [...union].every((id) => covered.has(id));
    if (ok) return role;
  }
  return null;
}

/** 新增这一条之后，这个人的有效角色是否比原来低。 */
export function lowersEffectiveRole(
  existing: readonly GrantShape[],
  added: GrantShape,
  now: number,
): boolean {
  const live = existing.filter(
    (one) => one.expiresAtMs == null || one.expiresAtMs > now,
  );
  const before = composeRole(live);
  if (before === null) return false;
  const after = composeRole([...live, added]);
  return after !== null && rank(after) < rank(before);
}
