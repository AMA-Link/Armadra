/**
 * 列仓库的拆解（契约 §29.7）与 GitLab 的 `/projects?membership=true`。Gitea 与
 * GitHub 经路由的那一段在 `forge.test.ts`。
 */

import { describe, expect, it } from "vitest";

import { GitlabForge } from "./gitlab";
import { fromWireProject, fromWireRepository, sshUrl } from "./repositories";

describe("拆解", () => {
  it("ssh 地址只收 ssh:// 与 scp 写法", () => {
    expect(sshUrl("git@git.example.com:acme/app.git")).toBe(
      "git@git.example.com:acme/app.git",
    );
    expect(sshUrl("ssh://git@git.example.com:2222/acme/app.git")).toBe(
      "ssh://git@git.example.com:2222/acme/app.git",
    );
    expect(sshUrl("javascript:alert(1)")).toBe("");
    expect(sshUrl("git@host:-oProxyCommand=x")).toBe("");
    expect(sshUrl("ssh://-oProxyCommand=x/a")).toBe("");
    expect(sshUrl("git@host:a b")).toBe("");
    expect(sshUrl(42)).toBe("");
  });

  it("名字不合格或没有 http(s) 克隆地址的行丢掉", () => {
    const base = {
      owner: { login: "acme" },
      clone_url: "https://git.example.com/acme/app.git",
    };
    expect(
      fromWireRepository("git.example.com", "gitea", { ...base, name: "app" })
        ?.cloneUrl,
    ).toBe("https://git.example.com/acme/app.git");
    expect(
      fromWireRepository("git.example.com", "gitea", { ...base, name: ".." }),
    ).toBeNull();
    expect(
      fromWireRepository("git.example.com", "gitea", {
        ...base,
        name: "app",
        clone_url: "file:///etc",
      }),
    ).toBeNull();
  });

  it("GitLab：owner 是完整的命名空间路径，非公开即私有", () => {
    expect(
      fromWireProject("gitlab.example.com", {
        path_with_namespace: "group/sub/app",
        visibility: "internal",
        forked_from_project: { id: 1 },
        default_branch: null,
        http_url_to_repo: "https://gitlab.example.com/group/sub/app.git",
        ssh_url_to_repo: "git@gitlab.example.com:group/sub/app.git",
        web_url: "https://gitlab.example.com/group/sub/app",
        last_activity_at: "2026-09-01T00:00:00Z",
      }),
    ).toEqual({
      host: "gitlab.example.com",
      owner: "group/sub",
      name: "app",
      forge: "gitlab",
      description: "",
      private: true,
      fork: true,
      archived: false,
      defaultBranch: "",
      cloneUrl: "https://gitlab.example.com/group/sub/app.git",
      sshUrl: "git@gitlab.example.com:group/sub/app.git",
      webUrl: "https://gitlab.example.com/group/sub/app",
      updatedAtMs: Date.parse("2026-09-01T00:00:00Z"),
    });
    expect(
      fromWireProject("gitlab.example.com", { path_with_namespace: "app" }),
    ).toBeNull();
  });
});

describe("GitLab /projects", () => {
  it("带令牌、按最近活动、每页 limit 个，下一页来自 Link 头", async () => {
    const seen: { url: string; token: string }[] = [];
    const forge = new GitlabForge({
      apiBase: "https://gitlab.example.com/api/v4",
      token: async () => "glpat-test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          token: headers.get("private-token") ?? "",
        });
        return new Response(
          JSON.stringify([
            {
              path_with_namespace: "acme/app",
              visibility: "public",
              http_url_to_repo: "https://gitlab.example.com/acme/app.git",
            },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: '<https://gitlab.example.com/api/v4/projects?page=2>; rel="next"',
            },
          },
        );
      }) as typeof fetch,
    });
    const page = await forge.repositories("gitlab.example.com", {
      page: 1,
      limit: 20,
    });
    expect(page.nextCursor).toBe("2");
    expect(page.items).toMatchObject([
      { owner: "acme", name: "app", private: false, sshUrl: "" },
    ]);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/api/v4/projects");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      membership: "true",
      order_by: "last_activity_at",
      sort: "desc",
      per_page: "20",
    });
    expect(seen[0]!.token).toBe("glpat-test");
  });
});
