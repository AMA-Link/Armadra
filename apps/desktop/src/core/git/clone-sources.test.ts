import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { apiFailure } from "../github/errors";
import { cleanupFixtures, temporaryDirectory } from "./fixture";
import {
  type RepositoryAccount,
  defaultCloneParent,
  listCloneRepositories,
} from "./clone-sources";

afterAll(() => cleanupFixtures());

describe("克隆的缺省父目录", () => {
  it("家目录下有 Projects 就用它", () => {
    const home = temporaryDirectory("clone-home-projects");
    mkdirSync(join(home, "code"));
    mkdirSync(join(home, "Projects"));
    expect(defaultCloneParent(home)).toEqual({
      parent: join(home, "Projects"),
    });
  });

  it("候选目录都没有就是家目录；没有家目录是空串", () => {
    const home = temporaryDirectory("clone-home-bare");
    expect(defaultCloneParent(home)).toEqual({ parent: home });
    expect(defaultCloneParent(undefined)).toEqual({ parent: "" });
  });
});

function account(
  options: {
    available?: boolean;
    login?: string;
    body?: unknown;
    failure?: unknown;
  } = {},
) {
  const get = vi.fn(async () => {
    if (options.failure !== undefined) throw options.failure;
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(options.body ?? [])),
    };
  });
  const fake = {
    status: async () => ({
      available: options.available ?? true,
      accountLogin: options.login ?? "octo",
    }),
    apiClient: () => ({ get }),
    noteFailure: vi.fn(),
    noteSuccess: vi.fn(),
  } satisfies RepositoryAccount;
  return { fake, get };
}

describe("已连接账号的仓库", () => {
  it("没有 GitHub 域或凭据不可用：未连接、空列表，不发请求", async () => {
    expect(await listCloneRepositories(undefined)).toEqual({
      connected: false,
      account: null,
      repositories: [],
    });
    const { fake, get } = account({ available: false });
    expect(await listCloneRepositories(fake)).toMatchObject({
      connected: false,
      repositories: [],
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("按 GitHub 的顺序答仓库，只留克隆名单认的 https 地址", async () => {
    const { fake, get } = account({
      body: [
        {
          full_name: "octo/one",
          clone_url: "https://github.com/octo/one.git",
          private: true,
          pushed_at: "2026-10-10T00:00:00Z",
          description: "不该出现在答案里",
        },
        {
          full_name: "octo/bad",
          clone_url: "file:///tmp/bad",
        },
        { full_name: 3 },
        {
          full_name: "org/two",
          clone_url: "https://github.com/org/two.git",
          updated_at: "2026-10-01T00:00:00Z",
        },
      ],
    });
    const answer = await listCloneRepositories(fake);
    expect(answer).toEqual({
      connected: true,
      account: "octo",
      repositories: [
        {
          fullName: "octo/one",
          cloneUrl: "https://github.com/octo/one.git",
          private: true,
          updatedAt: "2026-10-10T00:00:00Z",
        },
        {
          fullName: "org/two",
          cloneUrl: "https://github.com/org/two.git",
          private: false,
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    expect(get).toHaveBeenCalledWith("/user/repos", {
      per_page: "100",
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    expect(fake.noteSuccess).toHaveBeenCalled();
  });

  it("GitHub 拒绝凭据与连不上分成两个码，并记一次失败", async () => {
    const rejected = account({
      failure: apiFailure("UNAUTHENTICATED", 401, "TOKEN"),
    });
    await expect(listCloneRepositories(rejected.fake)).rejects.toMatchObject({
      status: 502,
      code: "forge_credential_rejected",
    });
    expect(rejected.fake.noteFailure).toHaveBeenCalled();

    const down = account({ failure: apiFailure("UNAVAILABLE", 503, "DOWN") });
    await expect(listCloneRepositories(down.fake)).rejects.toMatchObject({
      code: "forge_unavailable",
    });

    const odd = account({ body: { message: "not a list" } });
    await expect(listCloneRepositories(odd.fake)).rejects.toMatchObject({
      code: "forge_unavailable",
    });
  });
});
