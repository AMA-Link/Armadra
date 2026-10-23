import { errorStatus, isErrorCode } from "@armadra/platform-protocol/errors";

import { composeAccess, narrowed, type CloudRole } from "@/lib/cloud-grant";
import { CloudConsoleError } from "../api/errors";
import type { DirectoryState } from "./directory";
import {
  GOLDEN_OPS_ACCOUNT,
  MOCK_ACCOUNT,
  MOCK_HOSTS,
  MOCK_PEOPLE,
  MOCK_TEAMS,
  type MockHost,
} from "./fixtures";
import { selfOf, type TeamRow, type TeamsState } from "./teams";

/**
 * mock 里「团队主机与授予」的带状态数据与处理器（云端控制台 §3.3.4–§3.3.6，U5）：团队主机的可见性、
 * 授予（同主机同主体只有一条、更新整体替换范围、收窄即撤令牌）、有效权限合成与访问清单、主机设置、
 * 注册令牌。规则对照云端 `go/internal/cloud/grants`（`Compose`、`accessList`、`accessRevoke`、
 * `create` 的 409）与 `hosts/register.go`。处理器收原始入参，出参由 `create-mock-client.ts` 按契约校验。
 */
type Input = Record<string, unknown>;

export type GrantSubject =
  | { kind: "team"; teamId: string }
  | { kind: "member"; accountId: string }
  | { kind: "guest"; accountId: string };

export interface MockGrant {
  grantId: string;
  sourceId: string;
  subject: GrantSubject;
  role: CloudRole;
  workspaceIds: string[];
  expiresAtMs: number | null;
  grantedBy: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

export interface HostSettingsRow {
  linkCreators: "owner" | "owner_admin" | "driver";
  allowGuests: boolean;
  defaultRole: CloudRole;
}

export interface GrantsState {
  grants: MockGrant[];
  settings: Map<string, HostSettingsRow>;
  /** 主机的标签（`sources.update` 写）。 */
  tags: Map<string, string[]>;
  counter: number;
  /** 注册令牌发出了几枚。 */
  tokens: number;
  /** 本批被 `revokeAccess` 收窄的账号（测试读：收窄即撤令牌）。 */
  narrowed: { sourceId: string; accountId: string }[];
}

export interface GrantsOptions {
  /** 不种样本授予（空态测试用）。 */
  readonly noGrants?: boolean;
  /** 另外种一条协议包黄金夹具里的授予（契约一致性测试用）。 */
  readonly grantsGolden?: boolean;
}

/** 处理器要的上下文（`create-mock-client.ts` 的 `State` 满足它）。 */
export interface GrantsContext {
  teams: TeamsState;
  directory: DirectoryState;
  grants: GrantsState;
  emailVerified: boolean;
}

const DAY = 86_400_000;
const SELF = MOCK_ACCOUNT.accountId;
const HOUR_MS = 3_600_000;
export const WORKSPACES = {
  docs: "ws_mock_docs",
  api: "ws_mock_api",
  web: "ws_mock_web",
} as const;
export const GOLDEN_GRANT = "gnt_01JAAAAAAAAAAAAAAAAAAAAAAA";
/** 每个团队的主机额度（与 `teams.ts` 的 `LIMITS` 同值）。 */
const HOST_LIMIT = { free: 3, paid: 50 } as const;
/** 持久登记令牌的寿命。 */
const TOKEN_TTL_MS = 10 * 60_000;

export const DEFAULT_HOST_SETTINGS: HostSettingsRow = {
  linkCreators: "owner_admin",
  allowGuests: true,
  defaultRole: "viewer",
};

/** 样本里的主机号（`fixtures.ts` 的 `hex(n)`）。 */
const hostId = (n: number) =>
  n === 1
    ? "0123456789abcdef0123456789abcdef"
    : n.toString(16).padStart(32, "0");

export function createGrantsState(
  options: GrantsOptions & {
    /** 本人在各团队的角色覆盖（`TeamsOptions.roles`）：改成访客的团队，访客只被授予到每台主机的一个工作空间。 */
    readonly roles?: Readonly<Record<string, string>>;
  } = {},
): GrantsState {
  const now = Date.now();
  const rd = MOCK_TEAMS[0]!;
  const lisi = MOCK_PEOPLE.owner.accountId;
  const wangwu = MOCK_PEOPLE.member.accountId;
  const zhaoliu = MOCK_PEOPLE.guest.accountId;
  const grants: MockGrant[] = [];
  let n = 0;
  const add = (
    n1: number,
    subject: GrantSubject,
    role: CloudRole,
    workspaceIds: string[],
    expiresAtMs: number | null,
    grantedBy: string = SELF,
  ) =>
    grants.push({
      grantId: `gnt_mock_${++n}`,
      sourceId: hostId(n1),
      subject,
      role,
      workspaceIds,
      expiresAtMs,
      grantedBy,
      createdAtMs: now - (10 - n) * HOUR_MS,
      revokedAtMs: null,
    });
  if (!options.noGrants) {
    // build-01：团队全员只读；李四可执行整台；王五在 api 上可接管（被团队全员的整台只读合成降级）；
    // 赵六（访客）在 docs 与 api 上可编辑，一周后到期。
    add(1, { kind: "team", teamId: rd.teamId }, "viewer", [], null);
    add(1, { kind: "member", accountId: lisi }, "operator", [], now + 30 * DAY);
    add(
      1,
      { kind: "member", accountId: wangwu },
      "driver",
      [WORKSPACES.api],
      null,
    );
    add(
      1,
      { kind: "guest", accountId: zhaoliu },
      "editor",
      [WORKSPACES.docs, WORKSPACES.api],
      now + 7 * DAY,
    );
    // dev-box：团队全员可编辑。
    add(3, { kind: "team", teamId: rd.teamId }, "editor", [], null, lisi);
  }
  for (const team of MOCK_TEAMS)
    if (options.roles?.[team.slug] === "guest")
      for (const host of MOCK_HOSTS.filter(
        (row) => row.space?.kind === "team" && row.space.teamId === team.teamId,
      ))
        grants.push({
          grantId: `gnt_mock_guest_${host.sourceId.slice(-2)}`,
          sourceId: host.sourceId,
          subject: { kind: "guest", accountId: SELF },
          role: "viewer",
          workspaceIds: [WORKSPACES.docs],
          expiresAtMs: null,
          grantedBy: MOCK_PEOPLE.owner.accountId,
          createdAtMs: now,
          revokedAtMs: null,
        });
  if (options.grantsGolden)
    grants.push({
      grantId: GOLDEN_GRANT,
      sourceId: hostId(1),
      subject: { kind: "member", accountId: GOLDEN_OPS_ACCOUNT },
      role: "editor",
      workspaceIds: ["ws_01", "ws_02"],
      expiresAtMs: now + 30 * DAY,
      grantedBy: SELF,
      createdAtMs: now,
      revokedAtMs: null,
    });
  return {
    grants,
    settings: new Map(),
    tags: new Map(),
    counter: n,
    tokens: 0,
    narrowed: [],
  };
}

const fail = (code: string, details?: unknown): never => {
  throw new CloudConsoleError(
    code,
    isErrorCode(code) ? errorStatus(code) : 500,
    code,
    details,
  );
};

/* ------------------------------- 事实 ------------------------------- */

const teamOfHost = (
  ctx: GrantsContext,
  host: MockHost,
): TeamRow | undefined => {
  const { space } = host;
  return space?.kind === "team"
    ? ctx.teams.teams.find((team) => team.teamId === space.teamId)
    : undefined;
};

/** 主机所有者的账号：本人，或团队里显示名对得上的成员。 */
function ownerIdOf(ctx: GrantsContext, host: MockHost): string | undefined {
  if (host.owner) return SELF;
  const team = teamOfHost(ctx, host);
  return team?.members.find((member) => member.displayName === host.ownerName)
    ?.accountId;
}

const isStaff = (role: string | undefined) =>
  role === "owner" || role === "admin" || role === "member";

/** 本人能不能看到这台主机（云端 `ListHosts` 的可见性）。 */
function visible(ctx: GrantsContext, host: MockHost): boolean {
  const team = teamOfHost(ctx, host);
  if (!team) return host.space === undefined;
  const self = selfOf(team);
  if (!self || team.deletedAtMs !== null) return false;
  if (self.role === "owner" || self.role === "admin") return true;
  if (host.owner && isStaff(self.role)) return true;
  return compose(ctx, host, SELF).role !== null;
}

/** 本人能不能管理这台主机：所有者，或团队 owner / admin。 */
function manageable(ctx: GrantsContext, host: MockHost): boolean {
  if (host.owner) return true;
  const self = selfOf(teamOfHost(ctx, host) ?? ({ members: [] } as never));
  return self?.role === "owner" || self?.role === "admin";
}

function hostOf(ctx: GrantsContext, sourceId: unknown): MockHost {
  const found = ctx.directory.hosts.find((row) => row.sourceId === sourceId);
  if (!found || !visible(ctx, found)) return fail("not_found");
  return found;
}

/** 看得到且管得了；看得到管不了答 `team_role_insufficient`（团队主机）。 */
function managed(ctx: GrantsContext, sourceId: unknown): MockHost {
  const found = hostOf(ctx, sourceId);
  if (!manageable(ctx, found)) return fail("team_role_insufficient");
  return found;
}

const live = (grant: MockGrant, now: number) =>
  grant.revokedAtMs === null &&
  (grant.expiresAtMs === null || grant.expiresAtMs > now);

interface Source {
  via: "owner" | "team" | "member" | "guest";
  grantId: string | null;
  role: CloudRole;
  workspaceIds: string[];
  expiresAtMs: number | null;
  createdAtMs: number;
}

/** 一个账号对一台主机的有效权限（云端 `Compose` 的步骤 1–5）。 */
function compose(ctx: GrantsContext, host: MockHost, accountId: string) {
  const now = Date.now();
  const team = teamOfHost(ctx, host);
  const member = team?.members.find((one) => one.accountId === accountId);
  const from: Source[] = [];
  const empty = { role: null, from, composed: composeAccess([]) } as const;
  if (team && (team.deletedAtMs !== null || !member)) return empty;
  if (ownerIdOf(ctx, host) === accountId && (!team || isStaff(member?.role)))
    from.push({
      via: "owner",
      grantId: null,
      role: "driver",
      workspaceIds: [],
      expiresAtMs: null,
      createdAtMs: 0,
    });
  for (const grant of ctx.grants.grants) {
    if (grant.sourceId !== host.sourceId || !live(grant, now)) continue;
    const { subject } = grant;
    let via: Source["via"] | null = null;
    if (subject.kind === "team")
      via =
        team && isStaff(member?.role) && subject.teamId === team.teamId
          ? "team"
          : null;
    else if (subject.kind === "member")
      via =
        team && isStaff(member?.role) && subject.accountId === accountId
          ? "member"
          : null;
    else if (
      subject.accountId === accountId &&
      (!team || member?.role === "guest")
    )
      via = "guest";
    if (via)
      from.push({
        via,
        grantId: grant.grantId,
        role: grant.role,
        workspaceIds: [...grant.workspaceIds].sort(),
        expiresAtMs: grant.expiresAtMs,
        createdAtMs: grant.createdAtMs,
      });
  }
  if (from.length === 0) return empty;
  const composed = composeAccess(from);
  return { role: composed.role, from, composed };
}

const grantOut = (grant: MockGrant) => ({
  grantId: grant.grantId,
  sourceId: grant.sourceId,
  subject: grant.subject,
  role: grant.role,
  workspaceIds: grant.workspaceIds,
  expiresAtMs: grant.expiresAtMs,
  grantedBy: grant.grantedBy,
  createdAtMs: grant.createdAtMs,
  revokedAtMs: grant.revokedAtMs,
});

/** 这条授予影响哪些账号（团队全员 = 团队里的非访客成员）。 */
function affected(ctx: GrantsContext, grant: MockGrant): string[] {
  if (grant.subject.kind !== "team") return [grant.subject.accountId];
  const teamId = grant.subject.teamId;
  const team = ctx.teams.teams.find((row) => row.teamId === teamId);
  return (team?.members ?? [])
    .filter((member) => isStaff(member.role))
    .map((member) => member.accountId);
}

/** 授予变动前后各合成一次：收窄的账号记下来（云端会撤他们已签的令牌）。 */
function track(
  ctx: GrantsContext,
  host: MockHost,
  accounts: readonly string[],
  change: () => void,
) {
  const snapshot = () =>
    new Map(accounts.map((id) => [id, compose(ctx, host, id).composed]));
  const before = snapshot();
  change();
  const after = snapshot();
  for (const id of accounts) {
    if (narrowed(before.get(id)!, after.get(id)!))
      ctx.grants.narrowed.push({ sourceId: host.sourceId, accountId: id });
  }
}

const settingsOf = (ctx: GrantsContext, sourceId: string) => ({
  ...DEFAULT_HOST_SETTINGS,
  ...ctx.grants.settings.get(sourceId),
});

/* ------------------------------- 处理器 ------------------------------- */

type Handler = (input: Input, ctx: GrantsContext) => unknown;

const PAGE = 50;

function cleanWorkspaces(ids: unknown): string[] {
  const list = [...new Set((ids as string[] | undefined) ?? [])].sort();
  if (list.length > 64) fail("bad_request");
  return list;
}

const futureOnly = (value: unknown, now: number) => {
  if (typeof value === "number" && value <= now) fail("bad_request");
};

export function grantHandlers(
  personal: Readonly<
    Record<string, (input: Input, state: DirectoryState) => unknown>
  >,
): Readonly<Record<string, Handler>> {
  return {
    "sources.list": (input, ctx) => {
      const space = input.space as
        | { kind: string; teamId?: string }
        | undefined;
      if (space?.kind !== "team")
        return personal["sources.list"]!(input, ctx.directory);
      const team = ctx.teams.teams.find((row) => row.teamId === space.teamId);
      const self = team && selfOf(team);
      if (!team || !self) return fail("not_found");
      if (self.role === "billing") return fail("team_role_insufficient");
      const status = input.status as string | undefined;
      const q = typeof input.q === "string" ? input.q.toLowerCase() : "";
      const tags = (input.tag as string[] | undefined) ?? [];
      const rows = ctx.directory.hosts.filter(
        (host) =>
          host.space?.kind === "team" &&
          host.space.teamId === team.teamId &&
          visible(ctx, host) &&
          status !== "revoked" &&
          (status === undefined || (status === "online") === host.online) &&
          host.name.toLowerCase().includes(q) &&
          tags.every((tag) =>
            (ctx.grants.tags.get(host.sourceId) ?? host.tags)?.includes(tag),
          ),
      );
      const start = Number(input.cursor ?? 0);
      const limit = typeof input.limit === "number" ? input.limit : PAGE;
      const next = start + limit;
      return {
        sources: rows.slice(start, next).map((host) => withTags(ctx, host)),
        nextCursor: next < rows.length ? String(next) : null,
      };
    },
    "sources.get": (input, ctx) => {
      const found = hostOf(ctx, input.sourceId);
      return {
        ...withTags(ctx, found),
        trustedOrigins: [],
        capabilities: [],
        registeredAtMs: 0,
        ...(found.space ? { settings: settingsOf(ctx, found.sourceId) } : {}),
      };
    },
    "sources.update": (input, ctx) => {
      const found = hostOf(ctx, input.sourceId);
      if (!manageable(ctx, found)) return fail("team_role_insufficient");
      if (typeof input.name === "string") found.name = input.name;
      if (Array.isArray(input.tags))
        ctx.grants.tags.set(found.sourceId, input.tags as string[]);
      const patch = input.settings as Partial<HostSettingsRow> | undefined;
      if (patch && found.space)
        ctx.grants.settings.set(found.sourceId, {
          ...settingsOf(ctx, found.sourceId),
          ...patch,
        });
      return {
        ...withTags(ctx, found),
        trustedOrigins: [],
        capabilities: [],
        registeredAtMs: 0,
        ...(found.space ? { settings: settingsOf(ctx, found.sourceId) } : {}),
      };
    },
    "sources.registrationToken": (input, ctx) => {
      const space = input.space as
        | { kind: string; teamId?: string }
        | undefined;
      if (space?.kind === "team") {
        const team = ctx.teams.teams.find((row) => row.teamId === space.teamId);
        const self = team && selfOf(team);
        if (!team || !self) return fail("not_found");
        if (!ctx.emailVerified) fail("email_unverified");
        if (!isStaff(self.role)) fail("team_role_insufficient");
        if (team.deletedAtMs !== null) fail("team_deleted");
        if (self.role === "member" && !team.settings.membersCanRegisterHosts)
          fail("host_registration_disabled");
        const used = ctx.directory.hosts.filter(
          (host) =>
            host.space?.kind === "team" && host.space.teamId === team.teamId,
        ).length;
        const limit = HOST_LIMIT[team.plan === "free" ? "free" : "paid"];
        if (used >= limit)
          fail("limit_reached", { quota: "hosts", used, limit });
      } else if (!ctx.emailVerified) fail("email_unverified");
      ctx.grants.tokens += 1;
      return {
        registrationToken: `armadra-reg-mock-${ctx.grants.tokens}`,
        expiresAtMs: Date.now() + TOKEN_TTL_MS,
        issuer: "https://app.armadra.test",
      };
    },
    "sources.accessList": (input, ctx) => {
      const found = hostOf(ctx, input.sourceId);
      if (!found.space)
        return personal["sources.accessList"]!(input, ctx.directory);
      if (!manageable(ctx, found)) return fail("team_role_insufficient");
      const team = teamOfHost(ctx, found)!;
      const ids = new Set<string>();
      const owner = ownerIdOf(ctx, found);
      if (owner) ids.add(owner);
      for (const grant of ctx.grants.grants)
        if (grant.sourceId === found.sourceId && live(grant, Date.now()))
          for (const id of affected(ctx, grant)) ids.add(id);
      const access = [...ids].flatMap((accountId) => {
        const { role, from, composed } = compose(ctx, found, accountId);
        if (role === null) return [];
        const person = team.members.find(
          (member) => member.accountId === accountId,
        );
        const contributing = from.find(
          (source) =>
            source.grantId !== null &&
            source.via !== "owner" &&
            source.role === role &&
            (!composed.whole || source.workspaceIds.length === 0),
        );
        return [
          {
            accountId,
            email: person?.email ?? null,
            via: accountId === owner ? ("owner" as const) : ("team" as const),
            linkId: null,
            grantedAtMs: contributing?.createdAtMs ?? 0,
            ...(contributing?.grantId ? { grantId: contributing.grantId } : {}),
            role,
            workspaceIds: [...composed.workspaceIds],
            expiresAtMs: composed.expiresAtMs,
          },
        ];
      });
      return { access };
    },
    "sources.accessRevoke": (input, ctx) => {
      const found = managed(ctx, input.sourceId);
      if (!found.space)
        return personal["sources.accessRevoke"]!(input, ctx.directory);
      const target = String(input.accountId);
      const mine = ctx.grants.grants.filter(
        (grant) =>
          grant.sourceId === found.sourceId &&
          grant.revokedAtMs === null &&
          grant.subject.kind !== "team" &&
          grant.subject.accountId === target,
      );
      if (mine.length === 0) return fail("not_found");
      track(ctx, found, [target], () => {
        for (const grant of mine) grant.revokedAtMs = Date.now();
      });
      return {};
    },
    "grants.list": (input, ctx) => {
      if (input.sourceId === undefined && input.accountId === undefined)
        return fail("bad_request");
      if (input.groupId !== undefined) return fail("plan_feature_unavailable");
      const grants = ctx.grants.grants.filter((grant) => {
        if (grant.revokedAtMs !== null) return false;
        const found = ctx.directory.hosts.find(
          (host) => host.sourceId === grant.sourceId,
        );
        if (!found) return false;
        if (input.sourceId !== undefined) {
          if (grant.sourceId !== input.sourceId) return false;
          return true;
        }
        // 只给了账号：他作为主体、且在本人能管的主机上的授予（团队全员的授予不算「他」的）。
        return (
          grant.subject.kind !== "team" &&
          grant.subject.accountId === input.accountId &&
          visible(ctx, found) &&
          manageable(ctx, found)
        );
      });
      if (input.sourceId !== undefined) {
        const found = managed(ctx, input.sourceId);
        void found;
        const wanted = input.accountId;
        return {
          grants: grants
            .filter(
              (grant) =>
                wanted === undefined ||
                (grant.subject.kind !== "team" &&
                  grant.subject.accountId === wanted),
            )
            .map(grantOut),
        };
      }
      return { grants: grants.map(grantOut) };
    },
    "grants.create": (input, ctx) => {
      if (!ctx.emailVerified) fail("email_unverified");
      const subject = input.subject as GrantSubject | { kind: "group" };
      if (subject.kind === "group") return fail("plan_feature_unavailable");
      const found = managed(ctx, input.sourceId);
      const team = teamOfHost(ctx, found);
      const now = Date.now();
      futureOnly(input.expiresAtMs, now);
      const workspaceIds = cleanWorkspaces(input.workspaceIds);
      const owner = ownerIdOf(ctx, found);
      if (subject.kind === "team") {
        if (!team || subject.teamId !== team.teamId) fail("bad_request");
      } else {
        if (subject.accountId === owner) fail("bad_request");
        if (subject.kind === "member" && !team) fail("bad_request");
        if (
          subject.kind === "guest" &&
          !settingsOf(ctx, found.sourceId).allowGuests
        )
          fail("guests_disabled");
        const person = team?.members.find(
          (m) => m.accountId === subject.accountId,
        );
        if (team && !person) fail("not_found");
        if (person && subject.kind === "member" && !isStaff(person.role))
          fail("bad_request");
        if (person && subject.kind === "guest") {
          if (person.role !== "guest") fail("bad_request");
          if (!team!.settings.allowGuests) fail("guests_disabled");
        }
        if (subject.kind === "guest" && team && workspaceIds.length === 0)
          fail("bad_request");
      }
      const dup = ctx.grants.grants.some(
        (grant) =>
          grant.sourceId === found.sourceId &&
          grant.revokedAtMs === null &&
          grant.subject.kind === subject.kind &&
          (subject.kind === "team"
            ? true
            : grant.subject.kind !== "team" &&
              grant.subject.accountId === subject.accountId),
      );
      if (dup) fail("conflict");
      ctx.grants.counter += 1;
      const grant: MockGrant = {
        grantId: `gnt_mock_${ctx.grants.counter}`,
        sourceId: found.sourceId,
        subject,
        role: input.role as CloudRole,
        workspaceIds,
        expiresAtMs:
          typeof input.expiresAtMs === "number" ? input.expiresAtMs : null,
        grantedBy: SELF,
        createdAtMs: now,
        revokedAtMs: null,
      };
      track(ctx, found, affected(ctx, grant), () =>
        ctx.grants.grants.push(grant),
      );
      return grantOut(grant);
    },
    "grants.update": (input, ctx) => {
      const grant = ctx.grants.grants.find(
        (row) => row.grantId === input.grantId && row.revokedAtMs === null,
      );
      if (!grant) return fail("not_found");
      const found = managed(ctx, grant.sourceId);
      const now = Date.now();
      if (
        input.role === undefined &&
        input.workspaceIds === undefined &&
        input.expiresAtMs === undefined
      )
        fail("bad_request");
      futureOnly(input.expiresAtMs, now);
      const workspaceIds =
        input.workspaceIds === undefined
          ? undefined
          : cleanWorkspaces(input.workspaceIds);
      if (
        workspaceIds?.length === 0 &&
        grant.subject.kind === "guest" &&
        found.space
      )
        fail("bad_request");
      track(ctx, found, affected(ctx, grant), () => {
        if (input.role !== undefined) grant.role = input.role as CloudRole;
        if (workspaceIds !== undefined) grant.workspaceIds = workspaceIds;
        if (input.expiresAtMs !== undefined)
          grant.expiresAtMs = input.expiresAtMs as number | null;
      });
      return grantOut(grant);
    },
    "grants.revoke": (input, ctx) => {
      const grant = ctx.grants.grants.find(
        (row) => row.grantId === input.grantId && row.revokedAtMs === null,
      );
      if (!grant) return fail("not_found");
      const found = managed(ctx, grant.sourceId);
      track(ctx, found, affected(ctx, grant), () => {
        grant.revokedAtMs = Date.now();
      });
      return {};
    },
    "grants.effective": (input, ctx) => {
      const found = managed(ctx, input.sourceId);
      const accountId = String(input.accountId);
      const { role, from, composed } = compose(ctx, found, accountId);
      return {
        sourceId: found.sourceId,
        accountId,
        role,
        workspaceIds: [...composed.workspaceIds],
        expiresAtMs: composed.expiresAtMs,
        from: from.map((source) => ({
          via: source.via,
          grantId: source.grantId,
          role: source.role,
          workspaceIds: source.workspaceIds,
          expiresAtMs: source.expiresAtMs,
        })),
      };
    },
  };
}

function withTags(ctx: GrantsContext, host: MockHost) {
  const tags = ctx.grants.tags.get(host.sourceId) ?? host.tags;
  return { ...host, ...(tags ? { tags } : {}) };
}
