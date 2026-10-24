import { errorStatus, isErrorCode } from "@armadra/platform-protocol/errors";

import { CloudConsoleError } from "../api/errors";
import type { DirectoryState } from "./directory";
import {
  GOLDEN_OPS_ACCOUNT,
  GOLDEN_OPS_TEAM,
  MOCK_ACCOUNT,
  MOCK_PEOPLE,
  MOCK_TEAMS,
  type MockRole,
  type MockTeam,
} from "./fixtures";

/**
 * mock 里「团队空间」的带状态数据与处理器（云端控制台 §3.3，U4）：团队、成员、邀请、设置、
 * 用量。规则对照云端 `go/internal/cloud/teams` 与 `invitations`：admin 不能改 / 移除 owner、
 * 转移只能给 admin、最后一个 owner 不能降级 / 离开 / 被移除、移除或降级会撤其发出的待处理邀请、
 * 删除先要求没有在线主机并进 30 天恢复期、恢复按个人账号的团队数额度核对、guest 受设置与额度约束。
 * 处理器收原始入参，出参由 `create-mock-client.ts` 按契约校验。
 */
type Input = Record<string, unknown>;

export interface TeamMemberRow {
  accountId: string;
  email: string;
  displayName: string;
  role: MockRole;
  joinedAtMs: number;
  reachableHosts?: number;
}

export interface TeamInvitationRow {
  invitationId: string;
  kind: "team";
  email: string;
  state: "pending" | "accepted" | "declined" | "revoked" | "expired";
  teamId: string;
  teamRole: "admin" | "member" | "billing" | "guest";
  invitedBy: string;
  createdAtMs: number;
  expiresAtMs: number;
  decidedAtMs: number | null;
}

export interface TeamSettingsRow {
  membersCanRegisterHosts: boolean;
  defaultHostRole: "viewer" | "editor" | "operator" | "driver";
  allowGuests: boolean;
  allowAnonymousLinks: boolean;
  deviceEndorsers: "owner" | "owner_admin";
  memberSelfEndorse: boolean;
  requireMfa: boolean;
  sessionMaxAgeMs: number | null;
  allowedEmailDomains: string[];
}

export interface TeamRow {
  teamId: string;
  slug: string;
  name: string;
  avatarUrl: string | null;
  plan: string;
  createdAtMs: number;
  deletedAtMs: number | null;
  purgeAtMs: number | null;
  settings: TeamSettingsRow;
  members: TeamMemberRow[];
  invitations: TeamInvitationRow[];
}

export interface TeamsState {
  teams: TeamRow[];
  /** 递增编号：新团队与新邀请的号。 */
  counter: number;
}

/** 处理器要的上下文（`create-mock-client.ts` 的 `State` 满足它）。 */
export interface TeamsContext {
  teams: TeamsState;
  directory: DirectoryState;
  emailVerified: boolean;
}

export interface TeamsOptions {
  /** 本人在各团队的角色覆盖（角色矩阵测试用）。 */
  readonly roles?: Readonly<Record<string, MockRole>>;
  /** 一开始就没有这些团队（空态测试用）。 */
  readonly noTeams?: boolean;
  /** 另外种一个协议包黄金夹具里的团队（契约一致性测试用）：本人是所有者（`roles["dev-team"]` 可改），黄金账号是管理员，一条待处理邀请，没有主机。 */
  readonly golden?: boolean;
  /** 覆盖各团队的初始设置（如 `{ allowGuests: false }`）。 */
  readonly settings?: Partial<TeamSettingsRow>;
  /** 这些地址的团队一开始就在恢复期里（展示页与恢复页测试用）。 */
  readonly deleted?: readonly string[];
}

const DAY = 86_400_000;
export const RECOVERY_MS = 30 * DAY;
const SELF = MOCK_ACCOUNT.accountId;

/** 额度：Free 的团队 5 位成员、2 位访客；其余计划 50 / 50。个人账号 Free 只能拥有 1 个团队。 */
const LIMITS = {
  free: { members: 5, guests: 2, hosts: 3 },
  paid: { members: 50, guests: 50, hosts: 50 },
} as const;
const OWNED_TEAMS_FREE = 1;

export const DEFAULT_SETTINGS: TeamSettingsRow = {
  membersCanRegisterHosts: false,
  defaultHostRole: "viewer",
  allowGuests: true,
  allowAnonymousLinks: false,
  deviceEndorsers: "owner_admin",
  memberSelfEndorse: true,
  requireMfa: false,
  sessionMaxAgeMs: null,
  allowedEmailDomains: [],
};

/** 样本里的待处理邀请（团队 rd）。 */
export const MOCK_INVITE_EMAIL = "qian@example.com";
/** 另一条待处理邀请，由原所有者（李四）发出：他被降级或移除时一并撤销。 */
/** 已被接受的邀请：云端的列表照样返回它（控制台只显示待处理与已过期），撤销它答 conflict。 */
export const MOCK_INVITE_ACCEPTED = "done@example.test";
export const MOCK_INVITE_BY_OWNER = "chen@example.com";

const memberOf = (
  person: { accountId: string; email: string; displayName: string },
  role: MockRole,
  joinedAtMs: number,
): TeamMemberRow => ({
  ...person,
  role,
  joinedAtMs,
  ...(role === "guest" ? { reachableHosts: 2 } : {}),
});

function seedTeam(
  seed: MockTeam,
  options: TeamsOptions,
  index: number,
): TeamRow {
  const now = Date.now();
  const selfRole = options.roles?.[seed.slug] ?? seed.role;
  // 本人当所有者时，原来的所有者降为管理员：一个团队恰有一位所有者。
  const lisi: MockRole = selfRole === "owner" ? "admin" : "owner";
  const members: TeamMemberRow[] = [
    memberOf(MOCK_PEOPLE.owner, lisi, Date.UTC(2025, 2, 2)),
    memberOf(
      {
        accountId: SELF,
        email: MOCK_ACCOUNT.email,
        displayName: MOCK_ACCOUNT.displayName,
      },
      selfRole,
      Date.UTC(2025, 3, 10),
    ),
  ];
  if (seed.slug === "rd")
    members.push(
      memberOf(MOCK_PEOPLE.member, "member", Date.UTC(2025, 4, 9)),
      memberOf(MOCK_PEOPLE.guest, "guest", Date.UTC(2025, 5, 1)),
      memberOf(MOCK_PEOPLE.billing, "billing", Date.UTC(2025, 5, 20)),
    );
  const invitations: TeamInvitationRow[] =
    seed.slug === "rd"
      ? [
          {
            invitationId: "tinv_mock_qian",
            kind: "team",
            email: MOCK_INVITE_EMAIL,
            state: "pending",
            teamId: seed.teamId,
            teamRole: "member",
            invitedBy: SELF,
            createdAtMs: now - DAY,
            expiresAtMs: now + 6 * DAY,
            decidedAtMs: null,
          },
          {
            invitationId: "tinv_mock_chen",
            kind: "team",
            email: MOCK_INVITE_BY_OWNER,
            state: "pending",
            teamId: seed.teamId,
            teamRole: "billing",
            invitedBy: MOCK_PEOPLE.owner.accountId,
            createdAtMs: now - 2 * DAY,
            expiresAtMs: now + 5 * DAY,
            decidedAtMs: null,
          },
          {
            invitationId: "tinv_mock_done",
            kind: "team",
            email: MOCK_INVITE_ACCEPTED,
            state: "accepted",
            teamId: seed.teamId,
            teamRole: "member",
            invitedBy: SELF,
            createdAtMs: now - 8 * DAY,
            expiresAtMs: now - DAY,
            decidedAtMs: now - 7 * DAY,
          },
          {
            invitationId: "tinv_mock_old",
            kind: "team",
            email: "old@example.com",
            state: "expired",
            teamId: seed.teamId,
            teamRole: "guest",
            invitedBy: MOCK_PEOPLE.owner.accountId,
            createdAtMs: now - 12 * DAY,
            expiresAtMs: now - 5 * DAY,
            decidedAtMs: null,
          },
        ]
      : [];
  const gone = options.deleted?.includes(seed.slug) === true;
  return {
    teamId: seed.teamId,
    slug: seed.slug,
    name: seed.name,
    avatarUrl: null,
    plan: seed.plan,
    createdAtMs: Date.UTC(2025, 2, 2 + index),
    deletedAtMs: gone ? now - 2 * DAY : null,
    purgeAtMs: gone ? now + RECOVERY_MS - 2 * DAY : null,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    members,
    invitations,
  };
}

function seedGolden(options: TeamsOptions): TeamRow {
  const now = Date.now();
  return {
    teamId: GOLDEN_OPS_TEAM,
    slug: "dev-team",
    name: "Dev Team",
    avatarUrl: null,
    plan: "free",
    createdAtMs: Date.UTC(2025, 9, 9),
    deletedAtMs: null,
    purgeAtMs: null,
    settings: { ...DEFAULT_SETTINGS },
    members: [
      memberOf(
        {
          accountId: SELF,
          email: MOCK_ACCOUNT.email,
          displayName: MOCK_ACCOUNT.displayName,
        },
        options.roles?.["dev-team"] ?? "owner",
        Date.UTC(2025, 9, 9),
      ),
      memberOf(
        {
          accountId: GOLDEN_OPS_ACCOUNT,
          email: "dev@armadra.test",
          displayName: "Dev",
        },
        "admin",
        Date.UTC(2025, 9, 9),
      ),
    ],
    invitations: [
      {
        invitationId: "tinv_01JAAAAAAAAAAAAAAAAAAAAAAA",
        kind: "team",
        // 黄金入参 `invitations.create` 邀请的是 alice：这条用别的邮箱，两者不撞。
        email: "carol@armadra.test",
        state: "pending",
        teamId: GOLDEN_OPS_TEAM,
        teamRole: "member",
        invitedBy: GOLDEN_OPS_ACCOUNT,
        createdAtMs: now,
        expiresAtMs: now + 7 * DAY,
        decidedAtMs: null,
      },
    ],
  };
}

export function createTeamsState(options: TeamsOptions = {}): TeamsState {
  return {
    teams: [
      ...(options.noTeams
        ? []
        : MOCK_TEAMS.map((seed, index) => seedTeam(seed, options, index))),
      ...(options.golden ? [seedGolden(options)] : []),
    ],
    counter: 0,
  };
}

/* ------------------------------- 查询助手 ------------------------------- */

export const selfOf = (team: TeamRow) =>
  team.members.find((member) => member.accountId === SELF);

/** 本人在所有未删除团队里的角色（`me.spaces` / `me.get` 与范围表用）。 */
export function activeMemberships(state: TeamsState) {
  return state.teams.flatMap((team) => {
    const self = selfOf(team);
    return self && team.deletedAtMs === null ? [{ team, role: self.role }] : [];
  });
}

/** 范围表用：本人在这个团队里的角色（含恢复期内的团队）。 */
export const roleIn = (state: TeamsState, teamId: string) => {
  const team = state.teams.find((row) => row.teamId === teamId);
  return team ? selfOf(team)?.role : undefined;
};

const fail = (code: string, details?: unknown): never => {
  throw new CloudConsoleError(
    code,
    isErrorCode(code) ? errorStatus(code) : 500,
    code,
    details,
  );
};

type Min = "any" | "directory" | "staff" | "admin" | "owner";
const MIN: Readonly<Record<Min, readonly MockRole[]>> = {
  any: ["owner", "admin", "member", "billing", "guest"],
  directory: ["owner", "admin", "member", "billing"],
  staff: ["owner", "admin", "member"],
  admin: ["owner", "admin"],
  owner: ["owner"],
};

/** 与云端 `teams.Require` 同序：不是成员 → 404，角色不够 → 403，恢复期内 → 410。 */
function require(
  state: TeamsState,
  teamId: unknown,
  min: Min,
  options: { allowDeleted?: boolean } = {},
) {
  const team = state.teams.find((row) => row.teamId === teamId);
  const self = team && selfOf(team);
  if (!team || !self) return fail("not_found");
  if (!MIN[min].includes(self.role)) return fail("team_role_insufficient");
  if (team.deletedAtMs !== null && !options.allowDeleted)
    return fail("team_deleted");
  return { team, self };
}

const planOf = (team: TeamRow) => (team.plan === "free" ? "free" : "paid");

const seats = (team: TeamRow) => ({
  members: team.members.filter((member) => member.role !== "guest").length,
  guests: team.members.filter((member) => member.role === "guest").length,
});

const pendingSeats = (team: TeamRow) => {
  const now = Date.now();
  const open = team.invitations.filter(
    (row) => row.state === "pending" && row.expiresAtMs > now,
  );
  return {
    members: open.filter((row) => row.teamRole !== "guest").length,
    guests: open.filter((row) => row.teamRole === "guest").length,
  };
};

/** 再加一位之前，已占 + 待处理的邀请是否已到上限（云端 `quota.Check`）。 */
function checkQuota(team: TeamRow, quota: "members" | "guests") {
  const used = seats(team)[quota] + pendingSeats(team)[quota];
  const limit = LIMITS[planOf(team)][quota];
  if (used >= limit) fail("limit_reached", { quota, used, limit });
}

const ownedTeams = (state: TeamsState) =>
  activeMemberships(state).filter((entry) => entry.role === "owner").length;

function checkTeamQuota(state: TeamsState) {
  const used = ownedTeams(state);
  if (used >= OWNED_TEAMS_FREE)
    fail("limit_reached", { quota: "teams", used, limit: OWNED_TEAMS_FREE });
}

/* ------------------------------- 线上形状 ------------------------------- */

const teamOut = (team: TeamRow) => ({
  teamId: team.teamId,
  slug: team.slug,
  name: team.name,
  avatarUrl: team.avatarUrl,
  role: selfOf(team)!.role,
  plan: team.plan,
  createdAtMs: team.createdAtMs,
  deletedAtMs: team.deletedAtMs,
  purgeAtMs: team.purgeAtMs,
});

const memberOut = (member: TeamMemberRow) => ({
  accountId: member.accountId,
  email: member.email,
  displayName: member.displayName,
  role: member.role,
  joinedAtMs: member.joinedAtMs,
  groups: [] as { groupId: string; name: string }[],
  ...(member.role === "guest"
    ? { reachableHosts: member.reachableHosts ?? 0 }
    : {}),
});

const invitationOut = (row: TeamInvitationRow) => {
  const state =
    row.state === "pending" && row.expiresAtMs <= Date.now()
      ? ("expired" as const)
      : row.state;
  return { ...row, state };
};

function memberById(team: TeamRow, accountId: unknown) {
  const found = team.members.find((member) => member.accountId === accountId);
  if (!found) return fail("not_found");
  return found as TeamMemberRow;
}

const hasAnotherOwner = (team: TeamRow, except: string) =>
  team.members.some(
    (member) => member.role === "owner" && member.accountId !== except,
  );

/** 此人发出的待处理邀请随之撤销（降级、移除、离开）。 */
function revokeInvitesBy(team: TeamRow, accountId: string) {
  for (const row of team.invitations)
    if (row.state === "pending" && row.invitedBy === accountId)
      row.state = "revoked";
}

const slugFree = (state: TeamsState, slug: string) =>
  !state.teams.some((team) => team.slug === slug);

/* ------------------------------- 处理器 ------------------------------- */

type Handler = (input: Input, ctx: TeamsContext) => unknown;

export const TEAM_HANDLERS: Readonly<Record<string, Handler>> = {
  "teams.create": (input, ctx) => {
    if (!ctx.emailVerified) fail("email_unverified");
    const slug = String(input.slug);
    const name = String(input.name).trim();
    if (name === "") fail("bad_request");
    if (!slugFree(ctx.teams, slug)) fail("team_slug_taken");
    checkTeamQuota(ctx.teams);
    ctx.teams.counter += 1;
    const team: TeamRow = {
      teamId: `team_mock_new${ctx.teams.counter}`,
      slug,
      name,
      avatarUrl: null,
      plan: "free",
      createdAtMs: Date.now(),
      deletedAtMs: null,
      purgeAtMs: null,
      settings: { ...DEFAULT_SETTINGS },
      members: [
        memberOf(
          {
            accountId: SELF,
            email: MOCK_ACCOUNT.email,
            displayName: MOCK_ACCOUNT.displayName,
          },
          "owner",
          Date.now(),
        ),
      ],
      invitations: [],
    };
    ctx.teams.teams.push(team);
    return teamOut(team);
  },
  "teams.list": (_input, ctx) => ({
    teams: ctx.teams.teams.flatMap((team) => {
      const self = selfOf(team);
      if (!self) return [];
      // 恢复期内的团队只给所有者（只有所有者能恢复）。
      if (team.deletedAtMs !== null && self.role !== "owner") return [];
      return [teamOut(team)];
    }),
  }),
  "teams.get": (input, ctx) =>
    teamOut(require(ctx.teams, input.teamId, "any").team),
  "teams.update": (input, ctx) => {
    const { team } = require(ctx.teams, input.teamId, "admin");
    if (typeof input.name === "string") {
      const name = input.name.trim();
      if (name === "") fail("bad_request");
      team.name = name;
    }
    if ("avatarUrl" in input)
      team.avatarUrl = (input.avatarUrl as string) ?? null;
    return teamOut(team);
  },
  "teams.delete": (input, ctx) => {
    const { team } = require(ctx.teams, input.teamId, "owner");
    const online = ctx.directory.hosts.some(
      (host) =>
        host.online &&
        host.space?.kind === "team" &&
        host.space.teamId === team.teamId,
    );
    if (online) {
      const onlineHosts = ctx.directory.hosts.filter(
        (host) =>
          host.online &&
          host.space?.kind === "team" &&
          host.space.teamId === team.teamId,
      ).length;
      throw new CloudConsoleError(
        "team_hosts_online",
        409,
        "team_hosts_online",
        {
          onlineHosts,
        },
      );
    }
    const now = Date.now();
    team.deletedAtMs = now;
    team.purgeAtMs = now + RECOVERY_MS;
    return { purgeAtMs: team.purgeAtMs };
  },
  "teams.restore": (input, ctx) => {
    const { team } = require(ctx.teams, input.teamId, "owner", {
      allowDeleted: true,
    });
    if (team.deletedAtMs !== null) {
      if (team.purgeAtMs !== null && team.purgeAtMs <= Date.now())
        fail("team_deleted");
      // 恢复等于重新拥有一个团队：按个人账号的团队数额度核对。
      checkTeamQuota(ctx.teams);
      team.deletedAtMs = null;
      team.purgeAtMs = null;
    }
    return teamOut(team);
  },
  "teams.transferOwnership": (input, ctx) => {
    const { team, self } = require(ctx.teams, input.teamId, "owner");
    const target = memberById(team, input.accountId);
    if (target.role !== "admin") fail("bad_request");
    target.role = "owner";
    self.role = "admin";
    return {};
  },
  "teams.members": (input, ctx) => ({
    members: require(ctx.teams, input.teamId, "directory").team.members.map(
      memberOut,
    ),
  }),
  "teams.memberRole": (input, ctx) => {
    const { team, self } = require(ctx.teams, input.teamId, "admin");
    const target = memberById(team, input.accountId);
    const role = input.role as MockRole;
    if (self.role === "admin" && target.role === "owner")
      fail("team_role_insufficient");
    if (target.role !== role) {
      if (target.role === "owner" && !hasAnotherOwner(team, target.accountId))
        fail("team_last_owner");
      if ((role === "guest") !== (target.role === "guest")) {
        if (role === "guest") {
          if (!team.settings.allowGuests) fail("guests_disabled");
          checkQuota(team, "guests");
        } else checkQuota(team, "members");
      }
      if (role !== "admin") revokeInvitesBy(team, target.accountId);
      target.role = role;
      if (role === "guest") target.reachableHosts = 0;
      else delete target.reachableHosts;
    }
    return memberOut(target);
  },
  "teams.memberRemove": (input, ctx) => {
    const { team, self } = require(ctx.teams, input.teamId, "admin");
    const target = memberById(team, input.accountId);
    if (self.role === "admin" && target.role === "owner")
      fail("team_role_insufficient");
    if (target.role === "owner" && !hasAnotherOwner(team, target.accountId))
      fail("team_last_owner");
    revokeInvitesBy(team, target.accountId);
    team.members = team.members.filter((member) => member !== target);
    return {};
  },
  "teams.leave": (input, ctx) => {
    const { team, self } = require(ctx.teams, input.teamId, "any");
    if (self.role === "owner" && !hasAnotherOwner(team, self.accountId))
      fail("team_last_owner");
    revokeInvitesBy(team, self.accountId);
    team.members = team.members.filter((member) => member !== self);
    return {};
  },
  "teams.settings": (input, ctx) => ({
    ...require(ctx.teams, input.teamId, "staff").team.settings,
  }),
  "teams.settingsUpdate": (input, ctx) => {
    const { team } = require(ctx.teams, input.teamId, "admin");
    const { teamId: _teamId, ...patch } = input;
    team.settings = { ...team.settings, ...patch } as TeamSettingsRow;
    return { ...team.settings };
  },
  "teams.usage": (input, ctx) => {
    const { team } = require(ctx.teams, input.teamId, "directory");
    const limits = LIMITS[planOf(team)];
    const hosts = ctx.directory.hosts.filter(
      (host) =>
        host.space?.kind === "team" && host.space.teamId === team.teamId,
    ).length;
    const count = seats(team);
    return {
      teamId: team.teamId,
      period: String(input.period ?? "2025-10"),
      usage: [
        { metric: "hosts", value: hosts, limit: limits.hosts },
        { metric: "members", value: count.members, limit: limits.members },
        { metric: "guests", value: count.guests, limit: limits.guests },
        {
          metric: "traffic",
          value: 1_288_490_189,
          limit: team.plan === "free" ? 5_368_709_120 : 161_061_273_600,
        },
      ],
    };
  },
};

/** `invitations.*`：团队邀请带状态，主机邀请与收到的邀请走原有的处理器（`fallback`）。 */
export function teamInvitationHandlers(
  fallback: Readonly<Record<string, Handler>>,
): Readonly<Record<string, Handler>> {
  return {
    "invitations.create": (input, ctx) => {
      if (input.kind !== "team")
        return fallback["invitations.create"]?.(input, ctx);
      if (!ctx.emailVerified) fail("email_unverified");
      const { team, self } = require(ctx.teams, input.teamId, "admin");
      const email = String(input.email).toLowerCase();
      const role = input.role as TeamInvitationRow["teamRole"];
      if (team.members.some((member) => member.email.toLowerCase() === email))
        fail("member_exists");
      const open = team.invitations.some(
        (row) =>
          row.state === "pending" &&
          row.expiresAtMs > Date.now() &&
          row.email.toLowerCase() === email,
      );
      if (open) fail("conflict");
      if (role === "guest") {
        if (!team.settings.allowGuests) fail("guests_disabled");
        checkQuota(team, "guests");
      } else checkQuota(team, "members");
      ctx.teams.counter += 1;
      const now = Date.now();
      const row: TeamInvitationRow = {
        invitationId: `tinv_mock_new${ctx.teams.counter}`,
        kind: "team",
        email: String(input.email),
        state: "pending",
        teamId: team.teamId,
        teamRole: role,
        invitedBy: self.accountId,
        createdAtMs: now,
        expiresAtMs: now + 7 * DAY,
        decidedAtMs: null,
      };
      team.invitations.push(row);
      return invitationOut(row);
    },
    "invitations.list": (input, ctx) => {
      if (input.box === "received" || typeof input.teamId !== "string")
        return fallback["invitations.list"]?.(input, ctx);
      const { team } = require(ctx.teams, input.teamId, "admin");
      return {
        invitations: team.invitations.map(invitationOut),
      };
    },
    "invitations.resend": (input, ctx) => {
      const { row } = managed(ctx.teams, input.invitationId);
      if (row.state === "revoked") fail("invitation_revoked");
      // 过期的邀请重发后回到待处理（换新令牌、重新计 7 天）；已接受 / 已拒绝的不能重发。
      if (row.state !== "pending" && row.state !== "expired") fail("conflict");
      row.state = "pending";
      row.expiresAtMs = Date.now() + 7 * DAY;
      return invitationOut(row);
    },
    "invitations.revoke": (input, ctx) => {
      const { row } = managed(ctx.teams, input.invitationId);
      if (row.state === "accepted" || row.state === "declined")
        fail("conflict");
      row.state = "revoked";
      return {};
    },
  };
}

/** 找邀请并核对管理权（团队 admin 以上）。 */
function managed(state: TeamsState, invitationId: unknown) {
  for (const team of state.teams) {
    const row = team.invitations.find(
      (entry) => entry.invitationId === invitationId,
    );
    if (row) {
      require(state, team.teamId, "admin");
      return { team, row };
    }
  }
  return fail("not_found");
}
