import {
  Activity,
  Building2,
  Flag,
  Gauge,
  House,
  Inbox,
  KeyRound,
  Link2,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  ShieldAlert,
  UserRound,
  Users,
  UsersRound,
  Fingerprint,
  Network,
  type LucideIcon,
} from "lucide-react";

import { navigate, spacePath, type RouteMatch } from "../router";

export type TeamRole = "owner" | "admin" | "member" | "billing" | "guest";

export interface ConsoleTeam {
  readonly slug: string;
  readonly name: string;
  readonly role: TeamRole;
}

export interface ConsoleUser {
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export type NavArea = "personal" | "team" | "ops";

export interface NavItem {
  /** 与路由表的 `nav` 对应。 */
  readonly id: string;
  /** 空间根地址之后的那一段，概览为空。 */
  readonly segment: string;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  /** 团队里能看到这一项的角色（云端控制台 §2.4）；不写是全部。 */
  readonly roles?: readonly TeamRole[];
}

const MANAGERS = ["owner", "admin"] as const;
const STAFF = [...MANAGERS, "member"] as const;

const item = (
  id: string,
  icon: LucideIcon,
  roles?: readonly TeamRole[],
  segment: string = id,
): NavItem => ({
  id,
  segment,
  icon,
  labelKey: `cloud.nav.${id}`,
  ...(roles ? { roles } : {}),
});

export const NAV: Readonly<Record<NavArea, readonly NavItem[]>> = {
  personal: [
    item("overview", House, undefined, ""),
    item("hosts", Server),
    item("links", Link2),
    item("account", UserRound),
    item("tokens", KeyRound),
  ],
  team: [
    item("overview", House, undefined, ""),
    item("hosts", Server, [...STAFF, "guest"]),
    item("members", Users, [...STAFF, "billing"]),
    item("groups", UsersRound, STAFF),
    item("grants", ShieldCheck, STAFF),
    item("requests", Inbox, STAFF),
    item("links", Link2, STAFF),
    item("trust", Fingerprint, [...STAFF, "guest"]),
    item("audit", ScrollText, MANAGERS),
    item("billing", Gauge, [...MANAGERS, "billing"]),
    item("settings", Settings),
    item("tokens", KeyRound, MANAGERS),
  ],
  ops: [
    item("tenants", Building2, undefined, ""),
    item("nodes", Network),
    item("status", Activity),
    item("abuse", ShieldAlert),
    item("flags", Flag),
  ],
};

/** 这个角色在团队导航里看得到的项。 */
export function visibleNav(area: NavArea, role?: TeamRole): readonly NavItem[] {
  return NAV[area].filter(
    (entry) =>
      !entry.roles || (role !== undefined && entry.roles.includes(role)),
  );
}

export function navHref(
  area: NavArea,
  entry: NavItem,
  teamSlug?: string,
): string {
  const root =
    area === "ops"
      ? "/ops"
      : spacePath(area === "personal" || !teamSlug ? "me" : { team: teamSlug });
  return entry.segment ? `${root}/${entry.segment}` : root;
}

export type Gate = "ok" | "notFound" | "forbidden";

/**
 * 路由放行（云端控制台 §1.4）：没有运营会话的人访问 `/ops/*` 与不认识的路径
 * 一样整页「找不到」，不暴露这一区；团队不存在也是找不到；角色看不到的团队页
 * 是「没有权限」。
 */
export function gate(
  match: RouteMatch | null,
  context: { teams: readonly ConsoleTeam[]; operator: boolean },
): Gate {
  if (match === null) return "notFound";
  if (match.area === "ops") return context.operator ? "ok" : "notFound";
  if (match.area !== "team") return "ok";
  const team = context.teams.find((row) => row.slug === match.params.team);
  if (!team) return "notFound";
  return visibleNav("team", team.role).some((entry) => entry.id === match.nav)
    ? "ok"
    : "forbidden";
}

/* ------------------------------ 上次的空间 ------------------------------ */

const SPACE_KEY = "armadra.cloud.space";

/** 记下当前空间（`me` 或团队地址），`/` 据此跳转。 */
export function rememberSpace(match: RouteMatch | null) {
  const value =
    match?.area === "personal"
      ? "me"
      : match?.area === "team"
        ? (match.params.team ?? null)
        : null;
  if (value === null) return;
  try {
    localStorage.setItem(SPACE_KEY, value);
  } catch {
    /* 存不了不影响使用。 */
  }
}

/** `/` 去哪：上次的空间，失效（团队没了）回个人空间。 */
export function homePath(teams: readonly ConsoleTeam[]): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SPACE_KEY);
  } catch {
    /* 同上。 */
  }
  return stored && stored !== "me" && teams.some((row) => row.slug === stored)
    ? spacePath({ team: stored })
    : spacePath("me");
}

export function goHome(teams: readonly ConsoleTeam[]) {
  navigate(homePath(teams), { replace: true });
}
