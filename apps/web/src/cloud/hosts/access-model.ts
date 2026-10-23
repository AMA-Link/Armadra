import {
  liveGrants,
  narrowsAccess,
  rankOf,
  type GrantShape,
} from "@/lib/cloud-grant";
import type { TeamMember } from "../team/data";
import type { HostAccess } from "./data";
import type { Grant, GrantRole, GrantSubject } from "./grants-data";

/**
 * 访问清单的行与「这次改动会不会收窄谁」的判断（云端控制台 §3.3.5、§3.3.6）。合成与收窄用
 * `lib/cloud-grant`——与分享弹层同一套规则；这里只负责把云端的授予列表、访问清单与成员目录
 * 拼成行，以及把一次新增 / 更新套到每个受影响的人身上。
 */
type AccessVia = "owner" | "direct" | "team" | "link";

export interface AccessRow {
  /** 行键：账号号，团队全员那一行是 `"team"`。 */
  readonly id: string;
  readonly kind: "team" | "person";
  readonly accountId: string | null;
  readonly name: string;
  readonly email: string | null;
  /** 合成后的有效角色。 */
  readonly role: GrantRole;
  /** 空 = 整台。 */
  readonly workspaceIds: readonly string[];
  readonly expiresAtMs: number | null;
  readonly via: AccessVia;
  /** 这一行自己的授予（团队行是团队全员那条，人是以他本人为主体的）。 */
  readonly grants: readonly Grant[];
  /** 有一条来源的角色高于合成结果（更宽而更低的授予压低了它）。 */
  readonly lowered: boolean;
}

const isStaff = (role: string) =>
  role === "owner" || role === "admin" || role === "member";

const isPerson = (grant: Grant, accountId: string) =>
  grant.subject.kind !== "team" &&
  grant.subject.kind !== "group" &&
  grant.subject.accountId === accountId;

/** 一个人在这台主机上适用的授予形状：团队全员（只给团队的非访客成员）加他本人的；所有者另有整台 driver。 */
export function shapesFor(
  accountId: string,
  grants: readonly Grant[],
  members: readonly TeamMember[],
  ownerId: string | null,
): GrantShape[] {
  const role = members.find((one) => one.accountId === accountId)?.role ?? "";
  const shapes: GrantShape[] = [];
  if (accountId === ownerId) shapes.push({ role: "driver", workspaceIds: [] });
  for (const grant of grants) {
    if (grant.revokedAtMs !== null) continue;
    if (
      grant.subject.kind === "team" ? isStaff(role) : isPerson(grant, accountId)
    )
      shapes.push(grant);
  }
  return shapes;
}

const label = (member: TeamMember | undefined, row: HostAccess) =>
  member?.displayName ?? row.email ?? row.accountId;

/** 团队全员一行在最前，随后是所有者与其他人（按名字）。 */
export function buildAccessRows(
  access: readonly HostAccess[],
  grants: readonly Grant[],
  members: readonly TeamMember[],
  teamName: string,
  now: number,
): AccessRow[] {
  const ownerId = access.find((row) => row.via === "owner")?.accountId ?? null;
  const rows: AccessRow[] = [];
  const everyone = grants.filter(
    (grant) => grant.subject.kind === "team" && grant.revokedAtMs === null,
  );
  if (everyone[0])
    rows.push({
      id: "team",
      kind: "team",
      accountId: null,
      name: teamName,
      email: null,
      role: everyone[0].role,
      workspaceIds: everyone[0].workspaceIds,
      expiresAtMs: everyone[0].expiresAtMs,
      via: "direct",
      grants: everyone,
      lowered: false,
    });
  const people = access.flatMap((row): AccessRow[] => {
    if (row.role === undefined) return [];
    const member = members.find((one) => one.accountId === row.accountId);
    const own = grants.filter(
      (grant) => grant.revokedAtMs === null && isPerson(grant, row.accountId),
    );
    const shapes = liveGrants(
      shapesFor(row.accountId, grants, members, ownerId),
      now,
    );
    const top = Math.max(-1, ...shapes.map((shape) => rankOf(shape.role)));
    return [
      {
        id: row.accountId,
        kind: "person",
        accountId: row.accountId,
        name: label(member, row),
        email: row.email,
        role: row.role,
        workspaceIds: row.workspaceIds ?? [],
        expiresAtMs: row.expiresAtMs ?? null,
        via:
          row.via === "owner"
            ? "owner"
            : row.via === "link"
              ? "link"
              : own.length > 0
                ? "direct"
                : "team",
        grants: own,
        lowered: rankOf(row.role) < top,
      },
    ];
  });
  people.sort(
    (a, b) =>
      Number(b.via === "owner") - Number(a.via === "owner") ||
      a.name.localeCompare(b.name),
  );
  return [...rows, ...people];
}

/** 一次改动：新增一条授予、改已有一条的角色 / 到期（范围不动），或撤销若干条。 */
export type GrantChange =
  | {
      readonly kind: "add";
      readonly subject: GrantSubject;
      readonly role: GrantRole;
      readonly workspaceIds: readonly string[];
      readonly expiresAtMs: number | null;
    }
  | {
      readonly kind: "update";
      readonly grantId: string;
      readonly role: GrantRole;
      /** `undefined` = 不改到期。 */
      readonly expiresAtMs?: number | null;
    }
  | { readonly kind: "revoke"; readonly grantIds: readonly string[] };

const affects = (subject: GrantSubject, member: TeamMember): boolean =>
  subject.kind === "team"
    ? isStaff(member.role)
    : subject.kind !== "group" && subject.accountId === member.accountId;

/** 这次改动会收窄的人（角色降低、范围变小或到期提前、没了访问，云端会撤他们已签的令牌）。 */
export function narrowedBy(input: {
  readonly grants: readonly Grant[];
  readonly members: readonly TeamMember[];
  readonly ownerId: string | null;
  readonly change: GrantChange;
  readonly now: number;
}): TeamMember[] {
  const { grants, members, ownerId, change, now } = input;
  const byId = (id: string) => grants.find((grant) => grant.grantId === id);
  let subjects: GrantSubject[];
  let next: Grant[];
  if (change.kind === "add") {
    subjects = [change.subject];
    next = [
      ...grants,
      {
        grantId: "",
        sourceId: "",
        subject: change.subject,
        role: change.role,
        workspaceIds: [...change.workspaceIds],
        expiresAtMs: change.expiresAtMs,
        grantedBy: "",
        createdAtMs: now,
        revokedAtMs: null,
      },
    ];
  } else if (change.kind === "update") {
    const target = byId(change.grantId);
    if (!target) return [];
    subjects = [target.subject];
    next = grants.map((grant) =>
      grant.grantId === change.grantId
        ? {
            ...grant,
            role: change.role,
            ...(change.expiresAtMs === undefined
              ? {}
              : { expiresAtMs: change.expiresAtMs }),
          }
        : grant,
    );
  } else {
    subjects = change.grantIds.flatMap((id) => byId(id)?.subject ?? []);
    next = grants.filter((grant) => !change.grantIds.includes(grant.grantId));
  }
  return members.filter(
    (member) =>
      member.accountId !== ownerId &&
      subjects.some((subject) => affects(subject, member)) &&
      narrowsAccess(
        shapesFor(member.accountId, grants, members, ownerId),
        shapesFor(member.accountId, next, members, ownerId),
        now,
      ),
  );
}

/** 撤销他本人的授予后，团队全员的授予（未过期）是否还让他保有访问：他得是团队的非访客成员。 */
export function coveredByTeam(
  accountId: string,
  grants: readonly Grant[],
  members: readonly TeamMember[],
  now: number,
): boolean {
  const member = members.find((one) => one.accountId === accountId);
  return (
    member !== undefined &&
    isStaff(member.role) &&
    grants.some(
      (grant) =>
        grant.subject.kind === "team" &&
        grant.revokedAtMs === null &&
        (grant.expiresAtMs === null || grant.expiresAtMs > now),
    )
  );
}
