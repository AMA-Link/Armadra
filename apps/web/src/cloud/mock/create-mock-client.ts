import {
  cloudContract,
  listProcedures,
  type ProcedureEntry,
} from "@armadra/platform-protocol/cloud-api";
import { errorStatus, isErrorCode } from "@armadra/platform-protocol/errors";

import type { CloudClient } from "../api/client";
import { CloudConsoleError } from "../api/errors";
import { createCsrfStore, type CloudApi } from "../api/session";
import {
  GOLDEN_OPS_TEAM,
  MOCK_ACCOUNT,
  MOCK_HOSTS,
  MOCK_OPS_ACCOUNTS,
  MOCK_OPS_NODES,
  MOCK_TEAMS,
  ROLE_SCOPES,
  type MockRole,
} from "./fixtures";

/**
 * 内存 mock（云端控制台 §6.3）：返回与真实客户端**同类型**的 {@link CloudApi}。每个过程
 * 先用契约里的 zod schema 校验入参，再按范围与角色表放行或答 `forbidden`，最后校验出参。
 * 账号、空间、主机与登录由下面的处理器带状态地答；其余过程答协议包夹具里的那份黄金样本
 * （各页批次里再换成带状态的实现）。只在 DEV 与测试里被 import。
 */
export interface MockOptions {
  /** 每次调用的延迟（毫秒）。 */
  readonly latencyMs?: number;
  /** 指定过程失败：`{ "sources.list": "limit_reached" }`（`?mockFail=sources.list:limit_reached`）。 */
  readonly fail?: Readonly<Record<string, string>>;
  /** 一开始就登录了（缺省 true）。 */
  readonly signedIn?: boolean;
  /** 账号已验证邮箱（缺省 false，与展示页一致）。 */
  readonly emailVerified?: boolean;
  /** 账号持有运营范围（缺省 false）。 */
  readonly operatorAccount?: boolean;
  /** 运营会话一开始就在（缺省 false）。 */
  readonly operatorSession?: boolean;
  /** 本人在各团队的角色覆盖（角色矩阵测试用）。 */
  readonly roles?: Readonly<Record<string, MockRole>>;
}

/** 协议包的黄金夹具：开发服务器与测试里都能 glob，生产构建不会 import 到这里。 */
const GOLDEN = import.meta.glob<{
  input?: unknown;
  output?: unknown;
  outputs?: unknown[];
}>(
  "../../../node_modules/@armadra/platform-protocol/fixtures/cloud-api/*.json",
  {
    eager: true,
    import: "default",
  },
);

export function goldenFixture(key: string) {
  const entry = Object.entries(GOLDEN).find(([path]) =>
    path.endsWith(`/${key}.json`),
  )?.[1];
  return entry ?? {};
}

function golden(key: string): unknown {
  const fixture = goldenFixture(key);
  return fixture.output ?? fixture.outputs?.[0] ?? {};
}

type Input = Record<string, unknown>;

/** 运营后台的带状态数据：停用状态、节点、事故开关与运营动作（审计最近的在前）。 */
interface AdminState {
  suspended: Set<string>;
  drained: Set<string>;
  incident: {
    pauseAssertions: boolean;
    pauseRegistrations: boolean;
    rejectNewConnections: boolean;
    updatedAtMs: number | null;
  };
  actions: { targetId: string; action: string; atMs: number }[];
}

const createAdminState = (): AdminState => ({
  suspended: new Set(),
  drained: new Set(),
  incident: {
    pauseAssertions: false,
    pauseRegistrations: false,
    rejectNewConnections: false,
    updatedAtMs: null,
  },
  actions: [],
});

interface State {
  signedIn: boolean;
  operatorSession: boolean;
  /** 运营登录走完密码，等两步验证。 */
  pendingOperator: boolean;
  displayName: string;
  emailVerified: boolean;
  admin: AdminState;
}
type Handler = (input: Input, state: State, options: MockOptions) => unknown;

const SESSION = golden("auth.refresh") as { session: object };
const sessionOf = (state: State) => ({
  ...SESSION,
  session: {
    ...SESSION.session,
    account: {
      accountId: MOCK_ACCOUNT.accountId,
      email: MOCK_ACCOUNT.email,
      displayName: state.displayName,
      emailVerified: state.emailVerified,
    },
  },
  csrfToken: "mock-csrf",
});

const rolesOf = (options: MockOptions) =>
  MOCK_TEAMS.map((team) => ({
    ...team,
    role: options.roles?.[team.slug] ?? team.role,
  }));

const NOW = Date.UTC(2025, 9, 9, 9, 6);
const opsTeams = () =>
  [
    {
      teamId: GOLDEN_OPS_TEAM,
      slug: "dev-team",
      name: "Dev Team",
      role: "member" as const,
      plan: "free",
    },
    ...MOCK_TEAMS,
  ].map((team, index) => ({
    team,
    memberCount: index === 0 ? 7 : 3,
    hostCount: index === 0 ? 3 : 2,
    createdAtMs: Date.UTC(2025, 2, 2 + index),
  }));

const recent = (state: State, targetId: string) =>
  state.admin.actions
    .filter((entry) => entry.targetId === targetId)
    .slice(-5)
    .reverse()
    .map((entry, index) => ({
      eventId: `evt_${entry.atMs}_${index}`,
      teamId: null,
      actor: { kind: "operator" as const, id: "acct_mock_operator" },
      action: entry.action,
      target: { kind: "tenant", id: entry.targetId },
      jti: null,
      ipPrefix: null,
      atMs: entry.atMs,
    }));

const accountOut = (state: State, id: string) => {
  const row = MOCK_OPS_ACCOUNTS.find((account) => account.accountId === id);
  if (!row) throw new CloudConsoleError("not_found", 404);
  return {
    accountId: row.accountId,
    email: row.email,
    displayName: row.displayName,
    emailVerified: true,
    status: state.admin.suspended.has(id)
      ? ("disabled" as const)
      : ("active" as const),
    plan: row.plan,
    hostCount: row.hostCount,
    teamCount: row.teamCount,
    createdAtMs: row.createdAtMs,
    lastSeenAtMs: NOW,
    seats: 1,
    relayBytesMonth: 12_582_912,
    recentActions: recent(state, id),
  };
};

const teamOut = (state: State, id: string) => {
  const row = opsTeams().find((entry) => entry.team.teamId === id);
  if (!row) throw new CloudConsoleError("not_found", 404);
  return {
    teamId: row.team.teamId,
    slug: row.team.slug,
    name: row.team.name,
    status: state.admin.suspended.has(id)
      ? ("suspended" as const)
      : ("active" as const),
    plan: row.team.plan,
    memberCount: row.memberCount,
    hostCount: row.hostCount,
    createdAtMs: row.createdAtMs,
    deletedAtMs: null,
    seats: row.memberCount,
    relayBytesMonth: 1_073_741_824,
    recentActions: recent(state, id),
  };
};

const statusOf = (state: State, id: string, kind: "account" | "team") =>
  state.admin.suspended.has(id)
    ? kind === "account"
      ? ("disabled" as const)
      : ("suspended" as const)
    : ("active" as const);

const ADMIN_HANDLERS: Readonly<Record<string, Handler>> = {
  "admin.tenants": (input, state) => {
    const q = typeof input.q === "string" ? input.q.toLowerCase() : "";
    const accounts = MOCK_OPS_ACCOUNTS.map((row) => ({
      kind: "account" as const,
      id: row.accountId,
      name: row.displayName,
      plan: row.plan,
      hostCount: row.hostCount,
      status: statusOf(state, row.accountId, "account"),
      createdAtMs: row.createdAtMs,
      search: `${row.displayName} ${row.email}`,
    }));
    const teams = opsTeams().map(({ team, hostCount, createdAtMs }) => ({
      kind: "team" as const,
      id: team.teamId,
      name: team.name,
      plan: team.plan,
      hostCount,
      status: statusOf(state, team.teamId, "team"),
      createdAtMs,
      search: `${team.name} ${team.slug}`,
    }));
    const tenants = [...teams, ...accounts]
      .filter((row) => row.search.toLowerCase().includes(q))
      .map(({ search: _search, ...row }) => row);
    return { tenants, nextCursor: null };
  },
  "admin.account": (input, state) => accountOut(state, String(input.accountId)),
  "admin.team": (input, state) => teamOut(state, String(input.teamId)),
  "admin.accountStatus": (input, state) => {
    const id = String(input.accountId);
    // 运营不能停用自己（否则最后一个运营账号把自己锁在门外）。
    if (input.status === "disabled" && id === MOCK_ACCOUNT.accountId)
      throw new CloudConsoleError("forbidden", 403);
    accountOut(state, id);
    if (input.status === "disabled") state.admin.suspended.add(id);
    else state.admin.suspended.delete(id);
    state.admin.actions.push({
      targetId: id,
      action:
        input.status === "disabled" ? "account.disable" : "account.enable",
      atMs: Date.now(),
    });
    return accountOut(state, id);
  },
  "admin.teamStatus": (input, state) => {
    const id = String(input.teamId);
    teamOut(state, id);
    if (input.status === "suspended") state.admin.suspended.add(id);
    else state.admin.suspended.delete(id);
    state.admin.actions.push({
      targetId: id,
      action: input.status === "suspended" ? "team.suspend" : "team.restore",
      atMs: Date.now(),
    });
    return teamOut(state, id);
  },
  "admin.relayNodes": (_input, state) => ({
    nodes: MOCK_OPS_NODES.map((row) => ({
      ...row,
      draining: row.draining || state.admin.drained.has(row.node),
      version: "0.10.0",
    })),
  }),
  "admin.relayNodeDrain": (input, state) => {
    const row = MOCK_OPS_NODES.find((node) => node.node === input.node);
    if (!row) throw new CloudConsoleError("not_found", 404);
    if (input.drain === true) state.admin.drained.add(row.node);
    return {
      ...row,
      draining: row.draining || state.admin.drained.has(row.node),
      version: "0.10.0",
    };
  },
  "admin.incident": (_input, state) => ({ ...state.admin.incident }),
  "admin.incidentSet": (input, state) => {
    const incident = state.admin.incident;
    for (const field of [
      "pauseAssertions",
      "pauseRegistrations",
      "rejectNewConnections",
    ] as const)
      if (typeof input[field] === "boolean") incident[field] = input[field];
    incident.updatedAtMs = Date.now();
    return { ...incident };
  },
};

/** 带状态的处理器；没有的过程答黄金夹具。 */
const HANDLERS: Readonly<Record<string, Handler>> = {
  ...ADMIN_HANDLERS,
  "platform.info": () => ({
    ...(golden("platform.info") as object),
    mode: "saas",
    registrationsOpen: true,
  }),
  "auth.login": (input, state, options) => {
    if (input.scope === "operator") {
      if (options.operatorAccount !== true)
        throw new CloudConsoleError("forbidden", 403);
      state.pendingOperator = true;
      return { mfa: { challengeId: "mock-mfa", methods: ["totp"] } };
    }
    state.signedIn = true;
    return sessionOf(state);
  },
  "auth.mfaVerify": (_input, state) => {
    if (state.pendingOperator) {
      state.pendingOperator = false;
      state.operatorSession = true;
    } else state.signedIn = true;
    return sessionOf(state);
  },
  "auth.refresh": (_input, state) => sessionOf(state),
  "auth.logout": (_input, state) => {
    state.signedIn = false;
    state.operatorSession = false;
    return {};
  },
  "auth.emailVerifyResend": () => ({}),
  "me.get": (_input, state, options) => ({
    ...(golden("me.get") as object),
    ...MOCK_ACCOUNT,
    displayName: state.displayName,
    emailVerified: state.emailVerified,
    teams: rolesOf(options).map(({ teamId, slug, name, role }) => ({
      teamId,
      slug,
      name,
      role,
    })),
    ...(options.operatorAccount ? { scopes: ["operator"] } : {}),
    csrfToken: "mock-csrf",
  }),
  "me.update": (input, state, options) => {
    if (typeof input.displayName === "string")
      state.displayName = input.displayName;
    return HANDLERS["me.get"]!({}, state, options);
  },
  "me.spaces": (_input, _state, options) => ({
    spaces: [
      { kind: "personal", plan: "free" },
      ...rolesOf(options).map(({ teamId, slug, name, role, plan }) => ({
        kind: "team",
        teamId,
        slug,
        name,
        role,
        plan,
      })),
    ],
  }),
  "sources.list": (input) => {
    const space = input.space as { kind: string; teamId?: string } | undefined;
    const status = input.status as string | undefined;
    const q = typeof input.q === "string" ? input.q.toLowerCase() : "";
    const sources = MOCK_HOSTS.filter((row) => {
      const inSpace =
        space === undefined ||
        (space.kind === "personal"
          ? row.space === undefined
          : row.space?.kind === "team" && row.space.teamId === space.teamId);
      return (
        inSpace &&
        (status === undefined || (status === "online") === row.online) &&
        row.name.toLowerCase().includes(q)
      );
    });
    return { sources, nextCursor: null };
  },
  "sources.get": (input) => {
    const found = MOCK_HOSTS.find((row) => row.sourceId === input.sourceId);
    if (!found) throw new CloudConsoleError("not_found", 404);
    return { ...(golden("sources.get") as object), ...found };
  },
};

/** 这个调用满足范围表（「满足其一即可」）吗。 */
function allowed(
  entry: ProcedureEntry,
  input: Input,
  state: State,
  options: MockOptions,
  asOperator: boolean,
): boolean {
  const space = input.space as { teamId?: string } | undefined;
  const teamId = (input.teamId ?? space?.teamId) as string | undefined;
  const role = rolesOf(options).find((team) => team.teamId === teamId)?.role;
  return entry.meta.scope.some((scope) => {
    if (scope === "anonymous") return true;
    if (scope === "operator") return asOperator && state.operatorSession;
    if (scope.startsWith("team:"))
      return (
        state.signedIn &&
        (role === undefined || ROLE_SCOPES[role].includes(scope))
      );
    // session / owner / group:lead：登录了就放行（资源归属在各页的带状态实现里再细化）。
    return (
      state.signedIn &&
      (scope === "session" || scope === "owner" || scope === "group:lead")
    );
  });
}

async function check(
  schema: unknown,
  value: unknown,
  fail: (issues: string) => never,
): Promise<unknown> {
  const standard = (
    schema as {
      "~standard"?: {
        validate(v: unknown): unknown;
      };
    }
  )["~standard"];
  if (!standard) return value;
  const result = (await standard.validate(value)) as {
    value?: unknown;
    issues?: readonly { message: string; path?: readonly unknown[] }[];
  };
  return result.issues
    ? fail(
        result.issues
          .map((i) => `${(i.path ?? []).join(".")}: ${i.message}`)
          .join("; "),
      )
    : result.value;
}

/** 内存里的客户端束（控制台与运营两个客户端共享同一份状态）。 */
export function createMockApi(options: MockOptions = {}): CloudApi {
  const state: State = {
    signedIn: options.signedIn ?? true,
    operatorSession: options.operatorSession ?? false,
    pendingOperator: false,
    displayName: MOCK_ACCOUNT.displayName,
    emailVerified: options.emailVerified ?? MOCK_ACCOUNT.emailVerified,
    admin: createAdminState(),
  };
  const lost = new Set<() => void>();
  const operatorChanged = createCsrfStore();
  const syncOperator = () =>
    operatorChanged.set(state.operatorSession ? "ops" : undefined);
  syncOperator();

  const build = (asOperator: boolean): CloudClient => {
    const root: Record<string, Record<string, unknown>> = {};
    for (const entry of listProcedures(cloudContract)) {
      const [group = "", name = ""] = entry.key.split(".");
      (root[group] ??= {})[name] = async (raw: unknown = {}) => {
        if (options.latencyMs)
          await new Promise((done) => setTimeout(done, options.latencyMs));
        const injected = options.fail?.[entry.key];
        if (injected !== undefined)
          throw new CloudConsoleError(
            injected,
            isErrorCode(injected) ? errorStatus(injected) : 500,
            injected,
            injected === "limit_reached" ? { quota: "hosts" } : undefined,
          );
        const procedure = entry.procedure["~orpc"] as {
          inputSchema?: unknown;
          outputSchema?: unknown;
        };
        const input = (await check(procedure.inputSchema, raw, (issues) => {
          throw new CloudConsoleError("bad_request", 400, issues);
        })) as Input;
        if (
          !allowed(
            entry,
            { ...(raw as Input), ...input },
            state,
            options,
            asOperator,
          )
        ) {
          const needsLogin = entry.meta.scope.every(
            (scope) => scope === "session" || scope === "operator",
          );
          throw new CloudConsoleError(
            needsLogin && !state.signedIn ? "session_expired" : "forbidden",
            needsLogin && !state.signedIn ? 401 : 403,
          );
        }
        const handler = HANDLERS[entry.key];
        // 0.10.0 的包还没有 `rejectNewConnections` 与排空的 `reason`：校验会把它们当未知键剥掉，
        // 所以处理器看原始入参，事故开关的答复校验后再补回这一项（升 0.11.0 后删）。
        const output = handler
          ? handler({ ...(raw as Input), ...input }, state, options)
          : golden(entry.key);
        syncOperator();
        const checked = await check(
          procedure.outputSchema,
          output,
          (issues) => {
            throw new CloudConsoleError(
              "internal",
              500,
              `mock ${entry.key} violates the contract: ${issues}`,
            );
          },
        );
        return entry.key.startsWith("admin.incident")
          ? {
              ...(checked as object),
              rejectNewConnections: (
                output as { rejectNewConnections?: boolean }
              ).rejectNewConnections,
            }
          : checked;
      };
    }
    return root as unknown as CloudClient;
  };

  const client = build(false);
  return {
    client,
    ops: build(true),
    ensureCsrf: async () => state.signedIn,
    invitationPreview: (invitationId, token) =>
      client.invitations.get({ invitationId, token }),
    operator: {
      active: () => state.operatorSession,
      subscribe: operatorChanged.subscribe,
    },
    onSessionLost(listener) {
      lost.add(listener);
      return () => lost.delete(listener);
    },
    async signOut() {
      state.signedIn = false;
      state.operatorSession = false;
      syncOperator();
    },
  };
}

/** `?mock&mockFail=sources.list:limit_reached&mockLatency=300&mockUnverified=0&mockOperator`。 */
export function mockOptionsFromSearch(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const fail: Record<string, string> = {};
  for (const entry of params.getAll("mockFail")) {
    const [key, code] = entry.split(":");
    if (key && code) fail[key] = code;
  }
  const latency = Number(params.get("mockLatency"));
  return {
    fail,
    ...(latency > 0 ? { latencyMs: latency } : {}),
    ...(params.has("mockVerified") ? { emailVerified: true } : {}),
    ...(params.has("mockOperator") ? { operatorAccount: true } : {}),
  };
}
