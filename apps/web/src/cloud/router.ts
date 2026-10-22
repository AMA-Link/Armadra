import { useMemo, useSyncExternalStore } from "react";

/**
 * 控制台的路由表（云端控制台 §0 #2、§1.4）：History API + 一张类型化的表，
 * 地址是唯一真相。`area` 决定外壳：`public` 无侧栏，其余带侧栏；`nav` 是侧栏里
 * 点亮的那一项。
 */
export type RouteArea = "public" | "home" | "personal" | "team" | "ops";

const ROUTE_TABLE = [
  { id: "login", pattern: "/login", area: "public" },
  { id: "register", pattern: "/register", area: "public" },
  { id: "verify", pattern: "/verify", area: "public" },
  { id: "reset", pattern: "/reset", area: "public" },
  { id: "device", pattern: "/device", area: "public" },
  { id: "invite", pattern: "/invite/:id", area: "public" },
  { id: "home", pattern: "/", area: "home" },
  { id: "me", pattern: "/me", area: "personal", nav: "overview" },
  { id: "meHosts", pattern: "/me/hosts", area: "personal", nav: "hosts" },
  { id: "meHost", pattern: "/me/hosts/:host", area: "personal", nav: "hosts" },
  { id: "meLinks", pattern: "/me/links", area: "personal", nav: "links" },
  { id: "meAccount", pattern: "/me/account", area: "personal", nav: "account" },
  { id: "meTokens", pattern: "/me/tokens", area: "personal", nav: "tokens" },
  { id: "team", pattern: "/t/:team", area: "team", nav: "overview" },
  { id: "teamHosts", pattern: "/t/:team/hosts", area: "team", nav: "hosts" },
  {
    id: "teamHost",
    pattern: "/t/:team/hosts/:host",
    area: "team",
    nav: "hosts",
  },
  {
    id: "teamMembers",
    pattern: "/t/:team/members",
    area: "team",
    nav: "members",
  },
  { id: "teamGroups", pattern: "/t/:team/groups", area: "team", nav: "groups" },
  { id: "teamGrants", pattern: "/t/:team/grants", area: "team", nav: "grants" },
  {
    id: "teamRequests",
    pattern: "/t/:team/requests",
    area: "team",
    nav: "requests",
  },
  { id: "teamLinks", pattern: "/t/:team/links", area: "team", nav: "links" },
  { id: "teamTrust", pattern: "/t/:team/trust", area: "team", nav: "trust" },
  { id: "teamAudit", pattern: "/t/:team/audit", area: "team", nav: "audit" },
  {
    id: "teamBilling",
    pattern: "/t/:team/billing",
    area: "team",
    nav: "billing",
  },
  {
    id: "teamSettings",
    pattern: "/t/:team/settings",
    area: "team",
    nav: "settings",
  },
  { id: "teamTokens", pattern: "/t/:team/tokens", area: "team", nav: "tokens" },
  { id: "ops", pattern: "/ops", area: "ops", nav: "tenants" },
  { id: "opsTenant", pattern: "/ops/tenants/:id", area: "ops", nav: "tenants" },
  { id: "opsNodes", pattern: "/ops/nodes", area: "ops", nav: "nodes" },
  { id: "opsStatus", pattern: "/ops/status", area: "ops", nav: "status" },
  { id: "opsAbuse", pattern: "/ops/abuse", area: "ops", nav: "abuse" },
  { id: "opsFlags", pattern: "/ops/flags", area: "ops", nav: "flags" },
] as const satisfies readonly {
  id: string;
  pattern: string;
  area: RouteArea;
  nav?: string;
}[];

export type RouteId = (typeof ROUTE_TABLE)[number]["id"];

export interface RouteMatch {
  readonly id: RouteId;
  readonly area: RouteArea;
  /** 侧栏里点亮的那一项（`public` / `home` 没有）。 */
  readonly nav: string | null;
  readonly params: Readonly<Record<string, string>>;
  /** 筛选、页签、分页游标（§1.4）。 */
  readonly query: URLSearchParams;
}

const segmentsOf = (path: string) => path.split("/").filter(Boolean);

/** 认不出（含不合法的转义）是 `null`：调用方整页显示「找不到」。 */
export function matchRoute(pathname: string, search = ""): RouteMatch | null {
  let actual: string[];
  try {
    actual = segmentsOf(pathname).map(decodeURIComponent);
  } catch {
    return null;
  }
  for (const def of ROUTE_TABLE) {
    const pattern = segmentsOf(def.pattern);
    if (pattern.length !== actual.length) continue;
    const params: Record<string, string> = {};
    const hit = pattern.every((part, index) => {
      if (!part.startsWith(":")) return part === actual[index];
      params[part.slice(1)] = actual[index]!;
      return true;
    });
    if (!hit) continue;
    return {
      id: def.id,
      area: def.area,
      nav: "nav" in def ? def.nav : null,
      params,
      query: new URLSearchParams(search),
    };
  }
  return null;
}

/** 空间的根地址：个人 `/me`，团队 `/t/<slug>`。 */
export function spacePath(space: "me" | { team: string }): string {
  return space === "me" ? "/me" : `/t/${encodeURIComponent(space.team)}`;
}

const listeners = new Set<() => void>();

/** 站内跳转；`replace` 不留历史（重定向用）。 */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  window.history[options.replace ? "replaceState" : "pushState"](null, "", to);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const currentHref = () => window.location.pathname + window.location.search;

/** 当前地址对应的路由；认不出是 `null`。 */
export function useRoute(): RouteMatch | null {
  const href = useSyncExternalStore(subscribe, currentHref, () => "/");
  return useMemo(() => {
    const [pathname = "/", search = ""] = href.split("?");
    return matchRoute(pathname, search);
  }, [href]);
}
