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
  MOCK_ACCOUNT,
  MOCK_HOSTS,
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
interface State {
  signedIn: boolean;
  operatorSession: boolean;
  /** 运营登录走完密码，等两步验证。 */
  pendingOperator: boolean;
  displayName: string;
  emailVerified: boolean;
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

/** 带状态的处理器；没有的过程答黄金夹具。 */
const HANDLERS: Readonly<Record<string, Handler>> = {
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
        const output = handler
          ? handler(input, state, options)
          : golden(entry.key);
        syncOperator();
        return check(procedure.outputSchema, output, (issues) => {
          throw new CloudConsoleError(
            "internal",
            500,
            `mock 的 ${entry.key} 违反契约：${issues}`,
          );
        });
      };
    }
    return root as unknown as CloudClient;
  };

  return {
    client: build(false),
    ops: build(true),
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
