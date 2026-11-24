/**
 * 工作空间 → 仓库（契约 §111.1）：remote 的读取与主 remote 选择、选择按工作空间
 * 持久化、SSH 别名、凭据剥离、平台探测、远程主机与非 git 的原因、PR 绑定用选中
 * 的 remote。git 与 ssh 全是注入的 mock；另有一条用真 git 的临时仓库。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pullBindDeps } from "../collab/control/pr-bind";
import type { CollabContext } from "../collab/service";
import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { githubFixture, type GithubFixture } from "../github/fixture";
import type { SecretBackend } from "../secrets/backend";
import type { CommandRunner } from "./exec";
import { PlatformProbe } from "./probe";
import { setWorkspaceRepository } from "./registry";
import { installRoutes } from "./routes";
import { ForgeService } from "./service";
import { SshAliasResolver } from "./ssh-alias";
import { ForgeStore } from "./store";
import { ForgeError } from "./types";
import { DomainError } from "../workspaces/support";
import {
  type GitReader,
  type RemoteHostReader,
  type RemoteStatusReader,
  WorkspaceRepositoryService,
} from "./workspace";

const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  setWorkspaceRepository(undefined);
  for (const close of closing.splice(0).reverse()) await close();
});

const WS = "ws-repo";

/** 一个 git 仓库的输出：`remote -v`、gh-resolved 的配置行、是不是 git。 */
interface FakeRepo {
  remotes: string;
  ghResolved?: string;
  notGit?: boolean;
}

function gitFor(repo: FakeRepo): GitReader {
  return async (_root, args) => {
    const verb = args.join(" ");
    if (verb === "rev-parse --show-toplevel") {
      return repo.notGit
        ? { status: 128, stdout: "" }
        : { status: 0, stdout: "/tmp/repo\n" };
    }
    if (verb === "remote -v") return { status: 0, stdout: repo.remotes };
    if (args[0] === "config") {
      return repo.ghResolved === undefined
        ? { status: 1, stdout: "" }
        : { status: 0, stdout: repo.ghResolved };
    }
    return { status: 1, stdout: "" };
  };
}

function verbose(remotes: Record<string, string>): string {
  return Object.entries(remotes)
    .flatMap(([name, url]) => [
      `${name}\t${url} (fetch)`,
      `${name}\t${url} (push)`,
    ])
    .join("\n");
}

interface Harness {
  readonly fixture: GithubFixture;
  readonly forge: ForgeService;
  readonly service: WorkspaceRepositoryService;
  readonly probeCalls: string[];
  readonly root: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里按需探查 JSON 响应体
  ): Promise<{ status: number; body: any }>;
}

async function harness(options: {
  repo: FakeRepo;
  ssh?: CommandRunner;
  probeRoutes?: Record<string, { status: number; body?: unknown }>;
  /** 远程执行主机上的 `git.remotes`；给了就把工作空间挂到执行主机上。 */
  remoteHost?: RemoteHostReader;
  /** 这些主机的探测永远不答（模拟不可达的内网主机）。 */
  hangHosts?: readonly string[];
  warmDeadlineMs?: number;
  git?: GitReader;
  remoteStatus?: RemoteStatusReader;
}): Promise<Harness> {
  const fixture = await githubFixture();
  closing.push(() => fixture.close());
  const probeCalls: string[] = [];
  const probe = new PlatformProbe({
    fetch: (async (input: unknown) => {
      const url = new URL(String(input));
      probeCalls.push(`${url.host}${url.pathname}`);
      if (options.hangHosts?.includes(url.host)) {
        return await new Promise<Response>(() => undefined);
      }
      const route = options.probeRoutes?.[url.pathname];
      return route === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(route.body ?? {}), {
            status: route.status,
          });
    }) as typeof globalThis.fetch,
  });
  const values = new Map<string, string>();
  const secrets: SecretBackend = {
    kind: "file",
    async get(name) {
      return values.get(name);
    },
    async set(name, value) {
      values.set(name, value);
    },
    async delete(name) {
      values.delete(name);
    },
  };
  const forge = new ForgeService({
    store: new ForgeStore(fixture.db.database),
    secrets: () => secrets,
    github: () => fixture.service,
    probe,
    ...(options.warmDeadlineMs === undefined
      ? {}
      : { warmDeadlineMs: options.warmDeadlineMs }),
  });
  const insert = fixture.db.database.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const root = mkdtempSync(join(tmpdir(), "armadra-forge-ws-"));
  closing.push(() => rmSync(root, { recursive: true, force: true }));
  insert.run(WS, WS, root, "2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z");
  if (options.remoteHost !== undefined) {
    fixture.db.database
      .prepare("UPDATE workspaces SET execution_host_id = ? WHERE id = ?")
      .run("host-remote", WS);
  }
  const service = new WorkspaceRepositoryService({
    database: fixture.db.database,
    forge,
    git: options.git ?? gitFor(options.repo),
    ...(options.remoteStatus === undefined
      ? {}
      : { remoteStatus: options.remoteStatus }),
    ...(options.remoteHost === undefined
      ? {}
      : { remoteHost: options.remoteHost }),
    ...(options.warmDeadlineMs === undefined
      ? {}
      : { warmDeadlineMs: options.warmDeadlineMs }),
    ssh: new SshAliasResolver({
      run: options.ssh ?? (async () => ({ ok: false, stdout: "" })),
    }),
  });
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, forge, service);
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
  return { fixture, forge, service, probeCalls, root, call };
}

const FORK = verbose({
  origin: "git@github.com:me/app.git",
  upstream: "https://github.com/acme/app.git",
});

describe("迁移 0066", () => {
  it("forge_workspace_remote 以工作空间为主键；移除工作空间时行随之删掉", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    h.service.selections.set(WS, "origin");
    expect(h.service.selections.get(WS)).toBe("origin");
    h.fixture.db.database
      .prepare("DELETE FROM workspaces WHERE id = ?")
      .run(WS);
    expect(h.service.selections.get(WS)).toBeNull();
  });
});

describe("主 remote 选择", () => {
  it("fork（upstream + origin）默认 upstream；切到 origin 后记住，null 回到默认", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    const first = await h.service.repository(WS);
    expect(first).toMatchObject({
      reason: "ok",
      selected: "upstream",
      selectedBy: "upstream",
    });
    expect(first.remotes.map((remote) => remote.name)).toEqual([
      "origin",
      "upstream",
    ]);
    expect(first.remotes[1]?.detection?.repository).toEqual({
      host: "github.com",
      owner: "acme",
      name: "app",
    });

    const chosen = await h.service.select(WS, "origin");
    expect(chosen).toMatchObject({ selected: "origin", selectedBy: "user" });
    // 重新读（模拟重启后）仍是用户选的
    expect(await h.service.repository(WS)).toMatchObject({
      selected: "origin",
      selectedBy: "user",
    });
    expect(await h.service.select(WS, null)).toMatchObject({
      selected: "upstream",
      selectedBy: "upstream",
    });
  });

  it("选一个不存在的 remote 被拒，不写库", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    await expect(h.service.select(WS, "ghost")).rejects.toBeInstanceOf(
      ForgeError,
    );
    expect(h.service.selections.get(WS)).toBeNull();
  });

  it("gh-resolved 先于 upstream；用户选择先于 gh-resolved", async () => {
    const h = await harness({
      repo: { remotes: FORK, ghResolved: "remote.origin.gh-resolved base\n" },
    });
    expect(await h.service.repository(WS)).toMatchObject({
      selected: "origin",
      selectedBy: "ghResolved",
    });
    expect(await h.service.select(WS, "upstream")).toMatchObject({
      selected: "upstream",
      selectedBy: "user",
    });
  });

  it("没有 upstream 与 origin 时取名字排序首个", async () => {
    const h = await harness({
      repo: {
        remotes: verbose({
          zeta: "https://github.com/z/z.git",
          fork: "https://github.com/f/f.git",
        }),
      },
    });
    expect(await h.service.repository(WS)).toMatchObject({
      selected: "fork",
      selectedBy: "first",
    });
  });
});

describe("原因", () => {
  it("不是 git 仓库、没有 remote", async () => {
    const notGit = await harness({ repo: { remotes: "", notGit: true } });
    expect(await notGit.service.repository(WS)).toEqual({
      reason: "notGit",
      selected: null,
      selectedBy: null,
      remotes: [],
    });
    const none = await harness({ repo: { remotes: "" } });
    expect((await none.service.repository(WS)).reason).toBe("noRemote");
  });

  it("远程执行主机上的工作空间：remoteHostUnavailable，不读控制端磁盘", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    h.fixture.db.database
      .prepare("UPDATE workspaces SET execution_host_id = ? WHERE id = ?")
      .run("host-remote", WS);
    expect(await h.service.repository(WS)).toEqual({
      reason: "remoteHostUnavailable",
      selected: null,
      selectedBy: null,
      remotes: [],
    });
    expect(await h.service.selectedRemoteUrl(WS)).toBeUndefined();
  });

  it("不存在的工作空间是 not_found", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    await expect(h.service.repository("nope")).rejects.toMatchObject({
      kind: "notFound",
    });
  });
});

describe("凭据剥离", () => {
  it("答复与路由响应里都没有地址里的凭据，识别仍按真实主机", async () => {
    const h = await harness({
      repo: {
        remotes: verbose({
          origin: "https://oauth2:ghp_SECRETSECRET@github.com/me/app.git",
        }),
      },
    });
    const answer = await h.call("POST", "/api/forge/workspace-repository", {
      workspaceId: WS,
    });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain("SECRET");
    expect(answer.body.remotes[0].url).toBe("https://github.com/me/app.git");
    expect(answer.body.remotes[0].detection.forge).toBe("github");
  });
});

describe("SSH 别名", () => {
  it("git@github-work:org/repo 识别为别名背后的真实主机", async () => {
    const ssh: CommandRunner = async (_file, args) => ({
      ok: true,
      stdout: `hostname ${args[1] === "github-work" ? "github.com" : args[1]}\n`,
    });
    const h = await harness({
      repo: { remotes: verbose({ origin: "git@github-work:org/repo.git" }) },
      ssh,
    });
    const answer = await h.service.repository(WS);
    expect(answer.remotes[0]?.detection).toMatchObject({
      forge: "github",
      repository: { host: "github.com", owner: "org", name: "repo" },
    });
    // 答复里的地址是用户的 remote 原样（只剥凭据），不是换过主机的那一个。
    expect(answer.remotes[0]?.url).toBe("git@github-work:org/repo.git");
  });

  it("ssh 不可用时用原值，主机认不出平台", async () => {
    const h = await harness({
      repo: { remotes: verbose({ origin: "git@github-work:org/repo.git" }) },
    });
    const answer = await h.service.repository(WS);
    expect(answer.remotes[0]?.detection).toMatchObject({
      forge: null,
      repository: { host: "github-work" },
    });
    expect(answer.selected).toBe("origin");
  });
});

describe("平台探测", () => {
  const remotes = verbose({ origin: "https://git.corp.test/team/app.git" });

  it("没有配置行的主机探出平台，credential 仍是 false；按主机缓存", async () => {
    const h = await harness({
      repo: { remotes },
      probeRoutes: {
        "/api/v1/version": { status: 200, body: { version: "1.22" } },
      },
    });
    const first = await h.service.repository(WS);
    expect(first.remotes[0]?.detection).toMatchObject({
      forge: "gitea",
      apiBase: "https://git.corp.test/api/v1",
      webUrl: "https://git.corp.test/team/app",
      credential: false,
      credentialSource: null,
      source: null,
      configKey: null,
    });
    const calls = h.probeCalls.length;
    expect(calls).toBeGreaterThan(0);
    await h.service.repository(WS);
    await h.service.repository(WS);
    expect(h.probeCalls).toHaveLength(calls);
  });

  it("配置行盖过探测；已知主机不探；没有探测结果的主机仍不认识", async () => {
    const h = await harness({
      repo: {
        remotes: verbose({
          origin: "https://git.corp.test/team/app.git",
          other: "https://gitlab.com/g/p.git",
          odd: "https://odd.test/a/b.git",
        }),
      },
      probeRoutes: {
        "/api/v4/version": { status: 401 },
      },
    });
    const answer = await h.service.repository(WS);
    const byName = Object.fromEntries(
      answer.remotes.map((remote) => [remote.name, remote.detection]),
    );
    expect(byName.origin?.forge).toBe("gitlab");
    expect(byName.other?.forge).toBe("gitlab");
    expect(h.probeCalls.some((call) => call.startsWith("gitlab.com"))).toBe(
      false,
    );

    const h2 = await harness({
      repo: { remotes: verbose({ odd: "https://odd.test/a/b.git" }) },
    });
    expect(
      (await h2.service.repository(WS)).remotes[0]?.detection,
    ).toMatchObject({ forge: null });
  });
});

describe("路由", () => {
  it("POST 读、PUT 切；答复同形；清掉选择", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    const read = await h.call("POST", "/api/forge/workspace-repository", {
      workspaceId: WS,
    });
    expect(read.body).toMatchObject({ selected: "upstream", reason: "ok" });
    const put = await h.call("PUT", "/api/forge/workspace-repository", {
      workspaceId: WS,
      remote: "origin",
    });
    expect(put.body).toMatchObject({ selected: "origin", selectedBy: "user" });
    const cleared = await h.call("PUT", "/api/forge/workspace-repository", {
      workspaceId: WS,
      remote: null,
    });
    expect(cleared.body.selectedBy).toBe("upstream");
    const missing = await h.call("POST", "/api/forge/workspace-repository", {});
    expect(missing.status).toBe(400);
    const unknown = await h.call("PUT", "/api/forge/workspace-repository", {
      workspaceId: WS,
      remote: "ghost",
    });
    expect(unknown.status).toBe(400);
  });
});

describe("PR 绑定用选中的 remote", () => {
  it("fork 上默认查 upstream，不再写死 origin；用户切换后跟着变", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    setWorkspaceRepository(h.service);
    const origin = pullBindDeps.current.originUrl;
    const context = {} as CollabContext;
    expect(await origin(context, WS)).toBe("https://github.com/acme/app.git");
    await h.service.select(WS, "origin");
    expect(await origin(context, WS)).toBe("git@github.com:me/app.git");
  });

  it("没有解析器、远程主机、读不到时是 undefined", async () => {
    const h = await harness({ repo: { remotes: FORK } });
    const origin = pullBindDeps.current.originUrl;
    expect(await origin({} as CollabContext, WS)).toBeUndefined();
    setWorkspaceRepository(h.service);
    expect(await origin({} as CollabContext, "nope")).toBeUndefined();
  });
});

describe("真 git 的临时仓库", () => {
  it("读出 fork 的两个 remote，剥掉地址里的凭据（隔离的 HOME 与配置）", async () => {
    const fixture = await githubFixture();
    closing.push(() => fixture.close());
    const root = mkdtempSync(join(tmpdir(), "armadra-forge-git-"));
    closing.push(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    mkdirSync(repo);
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: join(root, "none"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git("init", "-q");
    git("remote", "add", "origin", "https://tok@github.com/me/app.git");
    git("remote", "add", "upstream", "https://github.com/acme/app.git");
    git("config", "remote.origin.gh-resolved", "base");
    fixture.db.database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(WS, WS, repo, "2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z");
    const forge = new ForgeService({
      store: new ForgeStore(fixture.db.database),
      secrets: () => {
        throw new Error("no secrets");
      },
    });
    const previous = { ...process.env };
    Object.assign(process.env, {
      HOME: root,
      GIT_CONFIG_GLOBAL: join(root, "none"),
      GIT_CONFIG_NOSYSTEM: "1",
    });
    try {
      const service = new WorkspaceRepositoryService({
        database: fixture.db.database,
        forge,
        ssh: new SshAliasResolver({
          run: async () => ({ ok: false, stdout: "" }),
        }),
      });
      const answer = await service.repository(WS);
      expect(answer.reason).toBe("ok");
      expect(answer.selected).toBe("origin");
      expect(answer.selectedBy).toBe("ghResolved");
      expect(JSON.stringify(answer)).not.toContain("tok@");
    } finally {
      process.env.HOME = previous.HOME as string;
      delete process.env.GIT_CONFIG_GLOBAL;
      delete process.env.GIT_CONFIG_NOSYSTEM;
    }
  });
});

describe("远程执行主机上的工作空间", () => {
  /** 执行主机答的 `git.remotes`（地址在远端已脱敏）。 */
  const REMOTE_RECORDS = [
    {
      name: "origin",
      fetchUrl: "https://[redacted]@github.com/me/app.git",
      pushUrl: "https://[redacted]@github.com/me/app.git",
      redacted: true,
    },
    {
      name: "upstream",
      fetchUrl: "git@github-work:acme/app.git",
      pushUrl: "git@github-work:acme/app.git",
      redacted: false,
    },
  ];

  it("经执行主机读 remote：剥凭据、不读控制端磁盘、不跑本机 ssh -G", async () => {
    const targets: unknown[] = [];
    const sshCalls: string[] = [];
    const h = await harness({
      // 控制端磁盘上同名路径不是 git：答 ok 说明没读它
      repo: { remotes: "", notGit: true },
      remoteHost: async (target) => {
        targets.push(target);
        return REMOTE_RECORDS;
      },
      ssh: async (_command, args) => {
        sshCalls.push(args.join(" "));
        return { ok: true, stdout: "hostname github.com\n" };
      },
    });
    const answer = await h.service.repository(WS);
    expect(answer).toMatchObject({
      reason: "ok",
      selected: "upstream",
      selectedBy: "upstream",
    });
    expect(answer.remotes.map((remote) => remote.url)).toEqual([
      "https://github.com/me/app.git",
      "git@github-work:acme/app.git",
    ]);
    expect(answer.remotes[0]?.detection?.forge).toBe("github");
    // 别名属于远端的 ssh 配置：按原样识别，认不出平台
    expect(answer.remotes[1]?.detection?.repository.host).toBe("github-work");
    expect(answer.remotes[1]?.detection?.forge).toBeNull();
    expect(sshCalls).toEqual([]);
    expect(targets[0]).toMatchObject({ executionHostId: "host-remote" });
    expect(JSON.stringify(answer)).not.toContain("redacted");
    expect(await h.service.selectedRemoteUrl(WS)).toBe(
      "git@github-work:acme/app.git",
    );
  });

  it("用户选择照常持久化；远程不读 gh-resolved", async () => {
    const h = await harness({
      repo: { remotes: "", ghResolved: "remote.origin.gh-resolved base\n" },
      remoteHost: async () => REMOTE_RECORDS,
    });
    expect(await h.service.repository(WS)).toMatchObject({
      selectedBy: "upstream",
    });
    expect(await h.service.select(WS, "origin")).toMatchObject({
      selected: "origin",
      selectedBy: "user",
    });
    await expect(h.service.select(WS, "ghost")).rejects.toBeInstanceOf(
      ForgeError,
    );
  });

  it("断线 / 不支持答 remoteHostUnavailable，远端不是 git 答 notGit，没有 remote 答 noRemote", async () => {
    const down = await harness({
      repo: { remotes: FORK },
      remoteHost: async () => {
        throw new DomainError(503, "unavailable", "连接断开了");
      },
    });
    expect((await down.service.repository(WS)).reason).toBe(
      "remoteHostUnavailable",
    );
    expect(await down.service.selectedRemoteUrl(WS)).toBeUndefined();

    const unsupported = await harness({
      repo: { remotes: FORK },
      remoteHost: async () => {
        throw new DomainError(501, "unsupported", "no remote.git.v1");
      },
    });
    expect((await unsupported.service.repository(WS)).reason).toBe(
      "remoteHostUnavailable",
    );

    const notGit = await harness({
      repo: { remotes: FORK },
      remoteHost: async () => {
        throw new DomainError(
          400,
          "bad_request",
          "Path is not a Git working repository",
        );
      },
    });
    expect((await notGit.service.repository(WS)).reason).toBe("notGit");

    const none = await harness({
      repo: { remotes: FORK },
      remoteHost: async () => [],
    });
    expect(await none.service.repository(WS)).toEqual({
      reason: "noRemote",
      selected: null,
      selectedBy: null,
      remotes: [],
    });
  });
});

describe("远程执行主机的边界（#948 审查）", () => {
  const unavailable = async (error: Error): Promise<string> => {
    const h = await harness({
      repo: { remotes: FORK },
      remoteHost: async () => {
        throw error;
      },
    });
    return (await h.service.repository(WS)).reason;
  };

  it("只有「不是 git 仓库 / 不是目录」的 400 是 notGit；409、403、remote 过多都按主机连不上", async () => {
    expect(
      await unavailable(
        new DomainError(
          409,
          "instance_mismatch",
          "The request was addressed to another worker session",
        ),
      ),
    ).toBe("remoteHostUnavailable");
    expect(
      await unavailable(
        new DomainError(
          403,
          "forbidden",
          "Git repository is outside the authorized workspace",
        ),
      ),
    ).toBe("remoteHostUnavailable");
    expect(
      await unavailable(
        new DomainError(
          400,
          "bad_request",
          "This repository has more remotes than this view supports",
        ),
      ),
    ).toBe("remoteHostUnavailable");
    expect(await unavailable(new Error("socket hang up"))).toBe(
      "remoteHostUnavailable",
    );
    expect(
      await unavailable(
        new DomainError(
          400,
          "bad_request",
          "Path is not a working Git repository",
        ),
      ),
    ).toBe("notGit");
    expect(
      await unavailable(
        new DomainError(400, "bad_request", "Git path must be a directory"),
      ),
    ).toBe("notGit");
  });

  it("远端不答：超过时限答 remoteHostUnavailable，selectedRemoteUrl 也不挂住", async () => {
    const h = await harness({
      repo: { remotes: FORK },
      remoteHost: async () => await new Promise<unknown>(() => undefined),
      warmDeadlineMs: 50,
    });
    const started = Date.now();
    expect((await h.service.repository(WS)).reason).toBe(
      "remoteHostUnavailable",
    );
    expect(await h.service.selectedRemoteUrl(WS)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("超时后才失败的远端请求不成为未处理的拒绝", async () => {
    let reject: (error: Error) => void = () => undefined;
    const h = await harness({
      repo: { remotes: FORK },
      remoteHost: async () =>
        await new Promise<unknown>((_resolve, fail) => {
          reject = fail;
        }),
      warmDeadlineMs: 20,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect((await h.service.repository(WS)).reason).toBe(
        "remoteHostUnavailable",
      );
      reject(new DomainError(503, "unavailable", "连接断开了"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("远端脱敏的 ssh://[redacted]@ 整段去掉：展示与 PR 绑定都不带 [redacted]", async () => {
    const h = await harness({
      repo: { remotes: "" },
      remoteHost: async () => [
        {
          name: "origin",
          // ssh://git@github.com/me/app.git 经远端脱敏后的样子
          fetchUrl: "ssh://[redacted]@github.com/me/app.git",
          pushUrl: "ssh://[redacted]@github.com/me/app.git",
          redacted: true,
        },
      ],
    });
    const answer = await h.service.repository(WS);
    expect(answer.remotes[0]?.url).toBe("ssh://github.com/me/app.git");
    expect(answer.remotes[0]?.detection?.repository).toEqual({
      host: "github.com",
      owner: "me",
      name: "app",
    });
    expect(await h.service.selectedRemoteUrl(WS)).toBe(
      "ssh://github.com/me/app.git",
    );
    expect(JSON.stringify(answer)).not.toContain("redacted");
  });
});

describe("预热整体限时", () => {
  it("不可达主机的探测不拖住其余 remote，超时的先按未知给出", async () => {
    const h = await harness({
      repo: {
        remotes: verbose({
          origin: "https://github.com/me/app.git",
          intranet: "https://git.intranet.example/team/app.git",
        }),
      },
      hangHosts: ["git.intranet.example"],
      warmDeadlineMs: 50,
    });
    const started = Date.now();
    const answer = await h.service.repository(WS);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer.reason).toBe("ok");
    const byName = Object.fromEntries(
      answer.remotes.map((remote) => [remote.name, remote.detection]),
    );
    expect(byName.origin?.forge).toBe("github");
    expect(byName.intranet?.repository.host).toBe("git.intranet.example");
    expect(byName.intranet?.forge).toBeNull();
  });

  it("hosts() 并行预热：一个主机挂起不阻塞其余主机", async () => {
    const h = await harness({
      repo: {
        remotes: verbose({
          a: "https://git.intranet.example/team/app.git",
          b: "https://gitea.lan.example/team/app.git",
        }),
      },
      hangHosts: ["git.intranet.example"],
      probeRoutes: {
        "/api/v1/version": { status: 200, body: { version: "1" } },
      },
      warmDeadlineMs: 50,
    });
    await h.service.repository(WS);
    const started = Date.now();
    const table = await h.forge.hosts();
    expect(Date.now() - started).toBeLessThan(2_000);
    const byHost = Object.fromEntries(
      table.hosts.map((row) => [row.host, row.forge]),
    );
    expect(byHost["git.intranet.example"]).toBeNull();
    expect(byHost["gitea.lan.example"]).toBe("gitea");
  });
});

describe("branchAt（契约 §116）", () => {
  interface Replies {
    top?: string;
    branch?: string;
    upstream?: string;
    head?: string;
    cwdTop?: string;
    cwdRemotes?: string;
    remotes: string;
  }

  /** 按 cwd 与命令回答；以 `/lib` 结尾的 cwd 是嵌套 clone。 */
  function git(replies: Replies): GitReader {
    return async (dir, args) => {
      const verb = args.join(" ");
      const nested = /[\\/]lib$/.test(dir);
      const none = { status: 1, stdout: "" };
      const out = (stdout: string | undefined) =>
        stdout === undefined ? none : { status: 0, stdout: `${stdout}\n` };
      if (verb === "rev-parse --show-toplevel") {
        return out(
          nested ? (replies.cwdTop ?? "/other") : (replies.top ?? "/repo"),
        );
      }
      if (verb === "remote -v") {
        return out(nested ? replies.cwdRemotes : replies.remotes);
      }
      if (verb === "symbolic-ref --short -q HEAD") return out(replies.branch);
      if (verb.startsWith("rev-parse --abbrev-ref"))
        return out(replies.upstream);
      if (verb.startsWith("symbolic-ref --short -q refs/remotes/")) {
        return out(replies.head);
      }
      return none;
    };
  }

  async function setup(replies: Replies) {
    return await harness({ repo: { remotes: "" }, git: git(replies) });
  }

  const ORIGIN = verbose({ origin: "https://github.com/acme/app.git" });
  const FORKED = verbose({
    origin: "https://github.com/me/app.git",
    upstream: "https://github.com/acme/app.git",
  });

  it("本机：有 upstream 同仓库就是基仓库同名分支", async () => {
    const h = await setup({
      remotes: ORIGIN,
      branch: "feat/x",
      upstream: "origin/feat/x",
      head: "origin/main",
    });
    expect(await h.service.branchAt(WS, h.root)).toEqual({
      repo: "github.com/acme/app",
      branch: "feat/x",
      head: { repo: "github.com/acme/app", owner: "acme", name: "app" },
    });
  });

  it("本机：upstream 指向 fork 时 head 是 fork 仓库，分支名取 upstream 的", async () => {
    const h = await setup({
      remotes: FORKED,
      branch: "work",
      upstream: "origin/feat/y",
    });
    expect(await h.service.branchAt(WS, h.root)).toEqual({
      repo: "github.com/acme/app",
      branch: "feat/y",
      head: { repo: "github.com/me/app", owner: "me", name: "app" },
    });
  });

  it("本机：没有 upstream 按基仓库同名分支", async () => {
    const h = await setup({ remotes: FORKED, branch: "feat/z" });
    expect(await h.service.branchAt(WS, h.root)).toMatchObject({
      branch: "feat/z",
      head: { owner: "acme" },
    });
  });

  it("游离 HEAD、默认分支、不是 git 都答 null", async () => {
    const detached = await setup({ remotes: ORIGIN });
    expect(await detached.service.branchAt(WS, detached.root)).toBeNull();
    const onDefault = await setup({
      remotes: ORIGIN,
      branch: "trunk",
      head: "origin/trunk",
    });
    expect(await onDefault.service.branchAt(WS, onDefault.root)).toBeNull();
    const heuristic = await setup({ remotes: ORIGIN, branch: "main" });
    expect(await heuristic.service.branchAt(WS, heuristic.root)).toBeNull();
    const notGit = await setup({ remotes: ORIGIN, branch: "x", top: "" });
    expect(await notGit.service.branchAt(WS, notGit.root)).toBeNull();
  });

  it("嵌套 clone 用 cwd 自己的 remote 选基仓库", async () => {
    const h = await setup({
      remotes: ORIGIN,
      cwdRemotes: verbose({ origin: "https://github.com/other/lib.git" }),
      branch: "feat/n",
    });
    expect(await h.service.branchAt(WS, join(h.root, "lib"))).toMatchObject({
      repo: "github.com/other/lib",
    });
  });

  it("平台不认识的主机答 null", async () => {
    const h = await setup({
      remotes: verbose({ origin: "https://git.unknown.test/a/b.git" }),
      branch: "feat/q",
    });
    expect(await h.service.branchAt(WS, h.root)).toBeNull();
  });

  const HOST_REMOTES = [
    {
      name: "origin",
      fetchUrl: "https://[redacted]@github.com/acme/app.git",
      pushUrl: "",
      redacted: true,
    },
  ];

  it("执行主机：读 git.status 的分支，按基仓库同名分支", async () => {
    const paths: string[] = [];
    const h = await harness({
      repo: { remotes: "" },
      remoteHost: async () => HOST_REMOTES,
      remoteStatus: async (_target, path) => {
        paths.push(path);
        return { branch: "feat/r" };
      },
    });
    const root = h.root;
    expect(await h.service.branchAt(WS, join(root, "pkg"))).toEqual({
      repo: "github.com/acme/app",
      branch: "feat/r",
      head: { repo: "github.com/acme/app", owner: "acme", name: "app" },
    });
    expect(paths).toEqual(["pkg"]);
    expect(await h.service.branchAt(WS, "/elsewhere")).toBeNull();
  });

  it("执行主机不可达或游离 HEAD 答 null", async () => {
    const down = await harness({
      repo: { remotes: "" },
      remoteHost: async () => HOST_REMOTES,
      remoteStatus: async () => {
        throw new Error("offline");
      },
    });
    expect(await down.service.branchAt(WS, down.root)).toBeNull();
    const detached = await harness({
      repo: { remotes: "" },
      remoteHost: async () => HOST_REMOTES,
      remoteStatus: async () => ({ branch: null }),
    });
    expect(await detached.service.branchAt(WS, detached.root)).toBeNull();
    const gone = await harness({
      repo: { remotes: "" },
      remoteHost: async () => {
        throw new Error("offline");
      },
    });
    expect(await gone.service.branchAt(WS, gone.root)).toBeNull();
  });
});
