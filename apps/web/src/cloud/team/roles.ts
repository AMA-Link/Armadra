import type { TeamRole } from "../shell/model";

/**
 * 团队角色能做的事（云端控制台 §2.4、§3.3.2、§3.3.12）：页面按它决定渲染哪个动作，没有权限的
 * 动作不画（§3.0 权限）。规则对照云端 `go/internal/cloud/teams`：成员目录 owner / admin / member /
 * billing 可读；邀请和写操作要 admin 以上；admin 不能动 owner；转移与删除只有 owner；
 * 设置页只有 owner / admin 看得到全部，其余角色只有「离开团队」。
 */
export interface TeamCaps {
  /** 成员与访客页签。 */
  readonly viewMembers: boolean;
  /** 邀请页签、邀请成员、重新发送、撤销邀请。 */
  readonly manageInvitations: boolean;
  /** 设置页的常规与访问两组。 */
  readonly editSettings: boolean;
  readonly transfer: boolean;
  readonly delete: boolean;
  /** 本人的「离开团队」：除 owner 外每个角色都有（owner 要先转移所有权）。 */
  readonly leave: boolean;
  /** 概览里的卡：guest 只有主机；billing 没有主机。 */
  readonly overview: {
    readonly hosts: boolean;
    readonly members: boolean;
    readonly traffic: boolean;
    readonly plan: boolean;
  };
  /** 对某个成员能不能改角色 / 移除。 */
  canChangeRole(target: TeamRole): boolean;
  canRemove(target: TeamRole): boolean;
}

export function teamCaps(role: TeamRole): TeamCaps {
  const manager = role === "owner" || role === "admin";
  return {
    viewMembers: role !== "guest",
    manageInvitations: manager,
    editSettings: manager,
    transfer: role === "owner",
    delete: role === "owner",
    leave: role !== "owner",
    overview: {
      hosts: role !== "billing",
      members: role !== "guest",
      traffic: role !== "guest",
      plan: role !== "guest",
    },
    // 不能动 owner；改角色的目标不含 owner（契约 `memberRole` 的 role 排除 owner）。
    canChangeRole: (target) => manager && target !== "owner",
    canRemove: (target) => manager && target !== "owner",
  };
}

/** 邀请与改角色可选的角色（owner 只能经转移）。 */
export const INVITE_ROLES = ["admin", "member", "billing", "guest"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const ALL_ROLES = [
  "owner",
  "admin",
  "member",
  "billing",
  "guest",
] as const satisfies readonly TeamRole[];
