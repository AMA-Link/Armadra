/**
 * 凭据复用（契约 §111.6）：按主机的 GitHub（github.com 与企业版同时可用）、凭据
 * 来源、存着的令牌优先、开关（桌面壳缺省开、服务器壳缺省关）与持久、令牌不出现在
 * 响应 / 日志 / 库里。外部命令全是 mock。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import {
  fakeGithub,
  githubFixture,
  type FakeGithub,
  type GithubFixture,
} from "../github/fixture";
import type { SecretBackend } from "../secrets/backend";
import type { CommandRunner } from "./exec";
import { LocalLogins } from "./logins";
import { PlatformProbe } from "./probe";
import { ReuseSwitch, reuseDefault } from "./reuse";
import { installRoutes } from "./routes";
import { ForgeService } from "./service";
import { ForgeStore } from "./store";

const PUBLIC_TOKEN = "ghp_PublicTokenSecret0001";
const GHE_TOKEN = "ghp_EnterpriseTokenSecret02";
const GLAB_TOKEN = "glpat-GitlabTokenSecret03";

const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closing.splice(0).reverse()) await close();
});

interface Rig {
  readonly fixture: GithubFixture;
  readonly fake: FakeGithub;
  readonly service: ForgeService;
  readonly reuse: ReuseSwitch;
  readonly commands: string[];
  readonly secrets: Map<string, string>;
  call(
    method: string,
    path: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里按需探查 JSON 响应体
  ): Promise<{ status: number; body: any }>;
}

async function rig(
  options: {
    shell?: "desktop" | "server";
    env?: NodeJS.ProcessEnv;
    answer?: (file: string, args: readonly string[]) => string | undefined;
    probe?: Record<string, { status: number; body?: unknown }>;
  } = {},
): Promise<Rig> {
  const fixture = await githubFixture();
  closing.push(() => fixture.close());
  const fake = await fakeGithub();
  closing.push(() => fake.close());
  fake.route("GET /repos/octo/repo/issues", { body: [] });
  fake.route("GET /user/repos", { body: [] });
  const reuse = new ReuseSwitch(
    fixture.db.database,
    reuseDefault(options.shell, options.env ?? {}),
  );
  const commands: string[] = [];
  const answer =
    options.answer ??
    ((file, args) => {
      if (file === "gh" && args[3] === "github.com") return PUBLIC_TOKEN;
      if (file === "gh" && args[3] === "ghe.corp.test") return GHE_TOKEN;
      if (file === "glab" && args[4] === "gitlab.corp.test") return GLAB_TOKEN;
      return undefined;
    });
  const run: CommandRunner = async (file, args) => {
    commands.push([file, ...args].join(" "));
    const out = answer(file, args);
    return out === undefined
      ? { ok: false, stdout: "" }
      : { ok: true, stdout: `${out}\n` };
  };
  const logins = new LocalLogins({
    enabled: () => reuse.get(),
    run,
    readFile: async () => undefined,
    home: () => "/home/test",
    env: {},
    platform: "linux",
  });
  const secrets = new Map<string, string>();
  const backend: SecretBackend = {
    kind: "file",
    async get(name) {
      return secrets.get(name);
    },
    async set(name, value) {
      secrets.set(name, value);
    },
    async delete(name) {
      secrets.delete(name);
    },
  };
  const probe = new PlatformProbe({
    fetch: (async (input: unknown) => {
      const url = new URL(String(input));
      const route = options.probe?.[`${url.host}${url.pathname}`];
      return route === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(route.body ?? {}), {
            status: route.status,
          });
    }) as typeof globalThis.fetch,
  });
  const service = new ForgeService({
    store: new ForgeStore(fixture.db.database),
    secrets: () => backend,
    // 没有存着的 GitHub 凭据：不给 §5 的服务，检验纯按主机的复用路径。
    github: () => undefined,
    probe,
    logins,
    reuse,
    githubClient: {
      // 两个 API 根（api.github.com 与企业版 /api/v3）都落到同一个假 GitHub，
      // 记下原本要去的主机。
      fetch: (async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        headers.set("x-test-host", url.host);
        return await globalThis.fetch(
          `${fake.base}${url.pathname.replace(/^\/api\/v3/, "")}${url.search}`,
          { ...init, headers },
        );
      }) as typeof globalThis.fetch,
      sleep: async () => {},
    },
  });
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, service);
  const call = async (method: string, path: string, body?: unknown) => {
    const encoded = Buffer.from(
      body === undefined ? "" : JSON.stringify(body),
      "utf8",
    );
    const request = {
      ...emptyRequest(method, path),
      query: new URLSearchParams(),
      body: encoded,
      json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
    };
    return (await router.dispatch(method, path, request)) as {
      status: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里按需探查 JSON 响应体
      body: any;
    };
  };
  return { fixture, fake, service, reuse, commands, secrets, call };
}

describe("按主机的 GitHub", () => {
  it("github.com 与企业版同时可用，各用各自主机的令牌，只发往各自主机", async () => {
    const h = await rig({
      probe: {
        "ghe.corp.test/api/v3/meta": {
          status: 200,
          body: { installed_version: "3.12" },
        },
      },
    });
    const pub = await h.call(
      "GET",
      "/api/forge/repos/github.com/octo/repo/issues",
    );
    expect(pub.status).toBe(200);
    const ent = await h.call(
      "GET",
      "/api/forge/repos/ghe.corp.test/octo/repo/issues",
    );
    expect(ent.status).toBe(200);
    const issueCalls = h.fake.requests.filter(
      (r) => r.path === "/repos/octo/repo/issues",
    );
    expect(
      issueCalls.map((r) => [
        r.headers["x-test-host"],
        r.headers.authorization,
      ]),
    ).toEqual([
      ["api.github.com", `Bearer ${PUBLIC_TOKEN}`],
      ["ghe.corp.test", `Bearer ${GHE_TOKEN}`],
    ]);
    expect(h.commands).toEqual([
      "gh auth token --hostname github.com",
      "gh auth token --hostname ghe.corp.test",
    ]);
  });

  it("识别带 credentialSource；没有登录的主机 credential 为 false", async () => {
    const h = await rig({
      probe: { "ghe.corp.test/api/v3/meta": { status: 200, body: {} } },
    });
    const found = await h.call("GET", "/api/forge/repos/github.com/octo/repo");
    expect(found.body).toMatchObject({
      forge: "github",
      credential: true,
      credentialSource: "ghCli",
      accountLogin: null,
    });
    const gitlab = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://gitlab.com/g/p.git",
    });
    expect(gitlab.body).toMatchObject({
      forge: "gitlab",
      credential: false,
      credentialSource: null,
    });
    const missing = await h.call(
      "GET",
      "/api/forge/repos/github.com/octo/repo/issues",
    );
    expect(missing.status).toBe(200);
  });
});

describe("GitLab 经 glab", () => {
  it("已知或探测过的 GitLab 主机读 glab 的令牌；glab 没有时识别出来但没令牌", async () => {
    const h = await rig({
      probe: { "gitlab.corp.test/api/v4/version": { status: 401 } },
    });
    const detection = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "git@gitlab.corp.test:team/app.git",
    });
    expect(detection.body).toMatchObject({
      forge: "gitlab",
      credential: true,
      credentialSource: "glab",
      apiBase: "https://gitlab.corp.test/api/v4",
    });
    const noLogin = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://gitlab.com/g/p.git",
    });
    expect(noLogin.body).toMatchObject({ forge: "gitlab", credential: false });
  });
});

describe("存着的令牌优先，凭据来源", () => {
  it("配置行存着令牌就不读本机登录，来源是 stored；没有令牌的配置行用本机登录", async () => {
    const h = await rig({
      answer: (file) => (file === "glab" ? GLAB_TOKEN : undefined),
      probe: {},
    });
    const withoutToken = await h.call(
      "PUT",
      "/api/forge/configs/gitlab.corp.test",
      {
        forge: "gitlab",
        apiBase: "https://gitlab.corp.test",
      },
    );
    expect(withoutToken.status).toBe(200);
    const first = await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://gitlab.corp.test/team/app.git",
    });
    expect(first.body).toMatchObject({
      source: "config",
      credential: true,
      credentialSource: "glab",
    });
  });

  it("同一台机器上各平台的 credentialSource 各按各的来源", async () => {
    const h = await rig({
      answer: (file) =>
        file === "gh" ? PUBLIC_TOKEN : file === "glab" ? GLAB_TOKEN : undefined,
    });
    const sources: Record<string, unknown> = {};
    for (const [key, url] of [
      ["github", "https://github.com/o/r"],
      ["gitlab", "https://gitlab.com/o/r"],
    ] as const) {
      const out = await h.call("POST", "/api/forge/resolve", {
        remoteUrl: url,
      });
      sources[key] = out.body.credentialSource;
    }
    expect(sources).toEqual({ github: "ghCli", gitlab: "glab" });
  });
});

describe("开关", () => {
  it("缺省：桌面壳开，服务器壳关；ARMADRA_FORGE_REUSE_LOGINS=1 才在服务器壳开", () => {
    expect(reuseDefault("desktop", {})).toBe(true);
    expect(reuseDefault(undefined, {})).toBe(true);
    expect(reuseDefault("server", {})).toBe(false);
    expect(reuseDefault("server", { ARMADRA_FORGE_REUSE_LOGINS: "0" })).toBe(
      false,
    );
    expect(reuseDefault("server", { ARMADRA_FORGE_REUSE_LOGINS: "1" })).toBe(
      true,
    );
  });

  it("服务器壳缺省关：不起任何外部命令，识别里没有令牌，请求被当作没配置", async () => {
    const h = await rig({ shell: "server" });
    const hosts = await h.call("GET", "/api/forge/hosts");
    expect(hosts.body.reuseLocalLogins).toBe(false);
    const detection = await h.call(
      "GET",
      "/api/forge/repos/github.com/octo/repo",
    );
    expect(detection.body).toMatchObject({
      credential: false,
      credentialSource: null,
    });
    const issues = await h.call(
      "GET",
      "/api/forge/repos/github.com/octo/repo/issues",
    );
    expect(issues.status).toBeGreaterThanOrEqual(400);
    expect(issues.body.code).toBe("forge_not_configured");
    expect(h.commands).toEqual([]);
  });

  it("PUT 打开后才读，持久在库里（换一个开关对象仍是开）；关掉立即丢缓存", async () => {
    const h = await rig({ shell: "server" });
    expect(
      (await h.call("PUT", "/api/forge/reuse-local-logins", { enabled: true }))
        .body,
    ).toEqual({
      reuseLocalLogins: true,
    });
    const reopened = new ReuseSwitch(h.fixture.db.database, false);
    expect(reopened.get()).toBe(true);
    const on = await h.call("GET", "/api/forge/repos/github.com/octo/repo");
    expect(on.body).toMatchObject({
      credential: true,
      credentialSource: "ghCli",
    });
    const reads = h.commands.length;

    await h.call("PUT", "/api/forge/reuse-local-logins", { enabled: false });
    expect(new ReuseSwitch(h.fixture.db.database, true).get()).toBe(false);
    const off = await h.call("GET", "/api/forge/repos/github.com/octo/repo");
    expect(off.body).toMatchObject({
      credential: false,
      credentialSource: null,
    });
    const blocked = await h.call(
      "GET",
      "/api/forge/repos/github.com/octo/repo/issues",
    );
    expect(blocked.body.code).toBe("forge_not_configured");
    expect(h.commands).toHaveLength(reads);

    const bad = await h.call("PUT", "/api/forge/reuse-local-logins", {
      enabled: "yes",
    });
    expect(bad.status).toBe(400);
  });
});

describe("已识别的主机", () => {
  it("并集：见过的、配置表里的；带平台、来源与令牌状态", async () => {
    const h = await rig({
      probe: { "gitlab.corp.test/api/v4/version": { status: 401 } },
    });
    await h.call("PUT", "/api/forge/configs/git.cfg.test", {
      forge: "gitea",
      apiBase: "https://git.cfg.test",
    });
    await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://github.com/o/r.git",
    });
    await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "git@gitlab.corp.test:t/a.git",
    });
    await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://nothing.test/o/r.git",
    });
    const hosts = await h.call("GET", "/api/forge/hosts");
    expect(hosts.status).toBe(200);
    expect(hosts.body.reuseLocalLogins).toBe(true);
    const byHost = Object.fromEntries(
      hosts.body.hosts.map((row: { host: string }) => [row.host, row]),
    );
    expect(byHost["github.com"]).toEqual({
      host: "github.com",
      forge: "github",
      credentialSource: "ghCli",
      accountLogin: null,
      credential: true,
    });
    expect(byHost["gitlab.corp.test"]).toMatchObject({
      forge: "gitlab",
      credentialSource: "glab",
      credential: true,
    });
    expect(byHost["git.cfg.test"]).toMatchObject({
      forge: "gitea",
      credential: false,
      credentialSource: null,
    });
    expect(byHost["nothing.test"]).toMatchObject({
      forge: null,
      credential: false,
    });
    expect(hosts.body.hosts.map((row: { host: string }) => row.host)).toEqual(
      [...hosts.body.hosts.map((row: { host: string }) => row.host)].sort(),
    );
  });
});

describe("令牌不外露", () => {
  it("响应、日志与库里都没有复用来的令牌", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      });
    }
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const h = await rig({
      probe: {
        "ghe.corp.test/api/v3/meta": { status: 200, body: {} },
        "gitlab.corp.test/api/v4/version": { status: 401 },
      },
    });
    const responses = [
      await h.call("GET", "/api/forge/hosts"),
      await h.call("GET", "/api/forge/repos/github.com/octo/repo"),
      await h.call("GET", "/api/forge/repos/github.com/octo/repo/issues"),
      await h.call("GET", "/api/forge/repos/ghe.corp.test/octo/repo/issues"),
      await h.call("POST", "/api/forge/resolve", {
        remoteUrl: "git@gitlab.corp.test:t/a.git",
      }),
      await h.call("GET", "/api/forge/repos/github.com/octo/repo/issues/9"),
      await h.call("GET", "/api/forge/accounts"),
      await h.call("GET", "/api/forge/accounts/github.com/repos"),
    ];
    const everything = JSON.stringify(responses) + written.join("\n");
    for (const token of [PUBLIC_TOKEN, GHE_TOKEN, GLAB_TOKEN]) {
      expect(everything).not.toContain(token);
    }
    // 库：每张表的每一行
    const database = h.fixture.db.database;
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = database.prepare(`SELECT * FROM "${name}"`).all();
      const text = JSON.stringify(rows, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      for (const token of [PUBLIC_TOKEN, GHE_TOKEN, GLAB_TOKEN]) {
        expect(text, name).not.toContain(token);
      }
    }
    expect(h.secrets.size).toBe(0);
  });
});

describe("列仓库用本机登录", () => {
  it("accounts 含读到登录的主机；repositories 走按主机的 client", async () => {
    const h = await rig();
    await h.call("POST", "/api/forge/resolve", {
      remoteUrl: "https://github.com/o/r.git",
    });
    const accounts = await h.call("GET", "/api/forge/accounts");
    expect(accounts.body.accounts).toEqual([
      { host: "github.com", forge: "github", accountLogin: null },
    ]);
    const repos = await h.call("GET", "/api/forge/accounts/github.com/repos");
    expect(repos.status).toBe(200);
    const call = h.fake.requests.find((r) => r.path === "/user/repos");
    expect(call?.headers.authorization).toBe(`Bearer ${PUBLIC_TOKEN}`);
  });
});

describe("迁移 0067", () => {
  it("forge_reuse_local_logins 是单例", async () => {
    const h = await rig();
    const columns = h.fixture.db.database
      .prepare("SELECT name FROM pragma_table_info('forge_reuse_local_logins')")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual([
      "singleton",
      "enabled",
      "updated_at_ms",
    ]);
    expect(() =>
      h.fixture.db.database
        .prepare("INSERT INTO forge_reuse_local_logins VALUES (2, 1, 1)")
        .run(),
    ).toThrow();
  });
});
