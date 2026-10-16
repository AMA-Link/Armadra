/**
 * 托管配置按工作空间（契约 §75，迁移 0048）：工作空间自己的一份盖过整台机器的，
 * 读与识别带 `workspaceId` 时用它，增删改落在它自己的那份上；工作空间被移除时
 * 行随外键删掉。
 */

import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus";
import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import type { SecretBackend } from "../secrets/backend";
import { githubFixture, type GithubFixture } from "../github/fixture";
import {
  FAKE_GITEA,
  type FakeGitea,
  startFakeGitea,
} from "./fake-gitea.fixture";
import { FORGE_ROUTES, installRoutes } from "./routes";
import { watchWorkspaceRemoval } from "./index";
import { ForgeService, forgeRepo } from "./service";
import { ForgeStore } from "./store";

const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

const WS = "ws-alpha";
const OTHER = "ws-beta";
const REPO_PATH = `/api/forge/repos/127.0.0.1/${FAKE_GITEA.owner}/${FAKE_GITEA.repo}`;

interface Harness {
  readonly github: GithubFixture;
  readonly gitea: FakeGitea;
  readonly secrets: Map<string, string>;
  readonly service: ForgeService;
  call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
}

async function harness(): Promise<Harness> {
  const github = await githubFixture();
  closing.push(() => github.close());
  const gitea = await startFakeGitea();
  closing.push(() => gitea.close());
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
  let ids = 0;
  const service = new ForgeService({
    store: new ForgeStore(github.db.database),
    secrets: () => secrets,
    github: () => github.service,
    now: () => 1_800_000_000_000,
    newId: () => `id${(ids += 1)}`,
  });
  const insert = github.db.database.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const id of [WS, OTHER]) {
    insert.run(
      id,
      id,
      `/tmp/${id}`,
      "2026-10-12T00:00:00Z",
      "2026-10-12T00:00:00Z",
    );
  }
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, service);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ) => {
    const encoded = Buffer.from(
      body === undefined ? "" : JSON.stringify(body),
      "utf8",
    );
    const request = {
      ...emptyRequest(method, path),
      query: new URLSearchParams(query),
      body: encoded,
      json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
    };
    return (await router.dispatch(method, path, request)) as {
      status: number;
      body: any;
    };
  };
  return { github, gitea, secrets: values, service, call };
}

/** 整机：同一主机识别成 Gitea，但地址不通、没有令牌。 */
async function machineWithoutToken(h: Harness): Promise<void> {
  const answer = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
    forge: "gitea",
    apiBase: "http://127.0.0.1:9/elsewhere",
  });
  expect(answer.status).toBe(200);
}

/** 工作空间 WS：同一主机用能连上的 Gitea 与令牌。 */
async function workspaceWithToken(h: Harness): Promise<any> {
  const answer = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
    workspaceId: WS,
    forge: "gitea",
    apiBase: h.gitea.root,
    token: FAKE_GITEA.token,
  });
  expect(answer.status).toBe(200);
  return answer.body;
}

describe("迁移 0048", () => {
  it("有 forge_workspace_config，主键是工作空间加键", async () => {
    const h = await harness();
    const columns = h.github.db.database
      .prepare(
        "SELECT name, pk FROM pragma_table_info('forge_workspace_config')",
      )
      .all() as { name: string; pk: number }[];
    expect(
      columns.filter((column) => column.pk > 0).map((column) => column.name),
    ).toEqual(["workspace_id", "repo_key"]);
  });
});

describe("按工作空间的配置（§75）", () => {
  it("写在工作空间自己的那份上，答复带 workspaceId，整机列表看不到它", async () => {
    const h = await harness();
    await machineWithoutToken(h);
    const saved = await workspaceWithToken(h);
    expect(saved).toMatchObject({
      workspaceId: WS,
      repoKey: "127.0.0.1",
      credential: true,
      accountLogin: FAKE_GITEA.login,
      revision: 1,
    });
    const machine = await h.call("GET", FORGE_ROUTES.configs);
    expect(machine.body.configs).toHaveLength(1);
    expect(machine.body.configs[0]).toMatchObject({
      workspaceId: null,
      credential: false,
    });
    const own = await h.call("GET", FORGE_ROUTES.configs, undefined, {
      workspaceId: WS,
    });
    expect(own.body.configs).toEqual([saved]);
    const other = await h.call("GET", FORGE_ROUTES.configs, undefined, {
      workspaceId: OTHER,
    });
    expect(other.body.configs).toEqual([]);
  });

  it("识别：工作空间的行盖过整机的，别的工作空间仍用整机的", async () => {
    const h = await harness();
    await machineWithoutToken(h);
    await workspaceWithToken(h);
    const repo = forgeRepo("127.0.0.1", FAKE_GITEA.owner, FAKE_GITEA.repo);
    expect(h.service.detect(repo)).toMatchObject({
      forge: "gitea",
      credential: false,
      apiBase: "http://127.0.0.1:9/elsewhere/api/v1",
    });
    expect(h.service.detect(repo, WS)).toMatchObject({
      forge: "gitea",
      credential: true,
      apiBase: `${h.gitea.root}/api/v1`,
    });
    expect(h.service.detect(repo, OTHER).credential).toBe(false);
    const resolved = await h.call("POST", FORGE_ROUTES.resolve, {
      remoteUrl: `${h.gitea.root}/${FAKE_GITEA.owner}/${FAKE_GITEA.repo}.git`,
      workspaceId: WS,
    });
    expect(resolved.body).toMatchObject({ credential: true });
  });

  it("工作空间的仓库行先于它的主机行，主机行先于整机的仓库行", async () => {
    const h = await harness();
    const repo = forgeRepo("127.0.0.1", FAKE_GITEA.owner, FAKE_GITEA.repo);
    const put = (path: string, body: object) =>
      h.call("PUT", `/api/forge/configs/${path}`, body);
    await put(`127.0.0.1/${FAKE_GITEA.owner}/${FAKE_GITEA.repo}`, {
      forge: "gitlab",
      apiBase: "http://127.0.0.1:9/machine-repo",
    });
    await put("127.0.0.1", {
      workspaceId: WS,
      forge: "gitea",
      apiBase: "http://127.0.0.1:9/ws-host",
    });
    expect(h.service.detect(repo, WS).apiBase).toBe(
      "http://127.0.0.1:9/ws-host/api/v1",
    );
    await put(`127.0.0.1/${FAKE_GITEA.owner}/${FAKE_GITEA.repo}`, {
      workspaceId: WS,
      forge: "gitea",
      apiBase: "http://127.0.0.1:9/ws-repo",
    });
    expect(h.service.detect(repo, WS).apiBase).toBe(
      "http://127.0.0.1:9/ws-repo/api/v1",
    );
    expect(h.service.detect(repo).apiBase).toBe(
      "http://127.0.0.1:9/machine-repo/api/v4",
    );
  });

  it("读 issue：带 workspaceId 用它的令牌，不带时整机没有令牌就不发请求", async () => {
    const h = await harness();
    await machineWithoutToken(h);
    await workspaceWithToken(h);
    h.gitea.issues.push({
      number: 1,
      title: "hello",
      body: "",
      state: "open",
      labels: [],
      comments: 0,
    } as never);
    const before = h.gitea.requests.length;
    const machine = await h.call("GET", `${REPO_PATH}/issues`);
    expect(machine.status).toBe(409);
    expect(machine.body.code).toBe("forge_not_configured");
    expect(h.gitea.requests.length).toBe(before);
    const scoped = await h.call("GET", `${REPO_PATH}/issues`, undefined, {
      workspaceId: WS,
    });
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.map((item: any) => item.number)).toEqual([1]);
    expect(h.gitea.requests.at(-1)?.authorization).toBe(
      `token ${FAKE_GITEA.token}`,
    );
  });

  it("账号：工作空间带令牌的主机行算一个账号，盖过整机同一主机", async () => {
    const h = await harness();
    await machineWithoutToken(h);
    expect(h.service.accounts().filter((a) => a.forge !== "github")).toEqual(
      [],
    );
    await workspaceWithToken(h);
    const answer = await h.call("GET", FORGE_ROUTES.accounts, undefined, {
      workspaceId: WS,
    });
    expect(
      answer.body.accounts.filter((a: any) => a.forge !== "github"),
    ).toEqual([
      { host: "127.0.0.1", forge: "gitea", accountLogin: FAKE_GITEA.login },
    ]);
  });

  it("按 revision 改删工作空间的行，整机的那行不动", async () => {
    const h = await harness();
    await machineWithoutToken(h);
    const saved = await workspaceWithToken(h);
    const stale = await h.call(
      "DELETE",
      "/api/forge/configs/127.0.0.1",
      undefined,
      {
        workspaceId: WS,
        expectedRevision: "7",
      },
    );
    expect(stale.status).toBe(409);
    const removed = await h.call(
      "DELETE",
      "/api/forge/configs/127.0.0.1",
      undefined,
      {
        workspaceId: WS,
        expectedRevision: String(saved.revision),
      },
    );
    expect(removed.status).toBe(200);
    expect(h.secrets.size).toBe(0);
    expect(
      (await h.call("GET", FORGE_ROUTES.configs)).body.configs,
    ).toHaveLength(1);
  });

  it("没有这个工作空间：404，不存令牌", async () => {
    const h = await harness();
    const answer = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
      workspaceId: "ws-missing",
      forge: "gitea",
      apiBase: h.gitea.root,
      token: FAKE_GITEA.token,
    });
    expect(answer.status).toBe(404);
    expect(h.secrets.size).toBe(0);
  });

  it("workspaceId 不合格：400", async () => {
    const h = await harness();
    for (const workspaceId of [" ws", "a\nb", "x".repeat(257)]) {
      const answer = await h.call("GET", FORGE_ROUTES.configs, undefined, {
        workspaceId,
      });
      expect(answer.status).toBe(400);
    }
  });

  it("工作空间被移除时它的配置随之删掉", async () => {
    const h = await harness();
    await workspaceWithToken(h);
    h.github.db.database.prepare("DELETE FROM workspaces WHERE id = ?").run(WS);
    expect(h.service.configs(WS)).toEqual([]);
  });

  describe("移除时清令牌（#389）", () => {
    /** 与 `workspaces/routes.ts` 的 delete 同一个次序：说一声、删行、再说一声。 */
    function remove(h: Harness, bus: EventBus, id: string): void {
      bus.emit("workspace.removing", { workspaceId: id });
      h.github.db.database
        .prepare("DELETE FROM workspaces WHERE id = ?")
        .run(id);
      bus.emit("workspace.grants", { workspaceId: id, permissions: null });
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it("工作空间移除后，它的配置引用的令牌从密钥存储里一并删掉", async () => {
      const h = await harness();
      const bus = new EventBus();
      watchWorkspaceRemoval(bus, h.service);
      await workspaceWithToken(h);
      expect(h.secrets.size).toBe(1);
      remove(h, bus, WS);
      await settle();
      expect(h.secrets.size).toBe(0);
    });

    it("别的工作空间与整机配置的令牌不动", async () => {
      const h = await harness();
      const bus = new EventBus();
      watchWorkspaceRemoval(bus, h.service);
      await workspaceWithToken(h);
      const other = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
        workspaceId: OTHER,
        forge: "gitea",
        apiBase: h.gitea.root,
        token: FAKE_GITEA.token,
      });
      expect(other.status).toBe(200);
      const machine = await h.call("PUT", "/api/forge/configs/127.0.0.1", {
        forge: "gitea",
        apiBase: h.gitea.root,
        token: FAKE_GITEA.token,
      });
      expect(machine.status).toBe(200);
      expect(h.secrets.size).toBe(3);
      remove(h, bus, WS);
      await settle();
      expect(h.secrets.size).toBe(2);
      expect(h.service.configs(OTHER)).toHaveLength(1);
    });

    it("移除没有成功（没说「已移除」）时令牌留着", async () => {
      const h = await harness();
      const bus = new EventBus();
      watchWorkspaceRemoval(bus, h.service);
      await workspaceWithToken(h);
      bus.emit("workspace.removing", { workspaceId: WS });
      await settle();
      expect(h.secrets.size).toBe(1);
    });

    it("没有配置或没有令牌的工作空间移除不出错", async () => {
      const h = await harness();
      const bus = new EventBus();
      watchWorkspaceRemoval(bus, h.service);
      remove(h, bus, OTHER);
      await settle();
      expect(h.secrets.size).toBe(0);
    });
  });
});
