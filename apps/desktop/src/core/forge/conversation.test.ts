/**
 * 三个平台读 PR 讨论（契约 §103.2）：评论、行内评论、评审被统一成同一个形状，
 * 带稳定编号，未提交的评审草稿与系统备注不算，`x-poll-interval` 交给调用方。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeGithub, type FakeGithub } from "../github/fixture";
import { GithubForge } from "./github";
import type { GithubService } from "../github/service";
import {
  FAKE_GITEA,
  type FakeGitea,
  startFakeGitea,
} from "./fake-gitea.fixture";
import { GiteaForge } from "./gitea";
import { GITLAB_FIXTURE, replay } from "./gitlab-replay.fixture";
import { GitlabForge } from "./gitlab";

describe("GitHub", () => {
  let fake: FakeGithub;
  beforeEach(async () => {
    fake = await fakeGithub();
  });
  afterEach(async () => {
    await fake.close();
  });

  it("评论、行内评论与评审合并成一条时间线；草稿丢掉；轮询间隔取响应头", async () => {
    fake.route("GET /repos/octo/repo/issues/3/comments", {
      body: [
        {
          id: 11,
          user: { login: "alice" },
          body: "看起来不错",
          html_url: "https://github.com/octo/repo/pull/3#issuecomment-11",
          created_at: "2026-10-01T10:00:10Z",
        },
        { id: 12, user: null, body: "没有作者", created_at: "bad" },
      ],
      headers: { "x-poll-interval": "75" },
    });
    fake.route("GET /repos/octo/repo/pulls/3/comments", {
      body: [
        {
          id: 21,
          user: { login: "ci[bot]" },
          body: "行内意见",
          html_url: "https://github.com/octo/repo/pull/3#discussion_r21",
          created_at: "2026-10-01T10:00:05Z",
        },
      ],
    });
    fake.route("GET /repos/octo/repo/pulls/3/reviews", {
      body: [
        {
          id: 31,
          user: { login: "bob" },
          body: "请改一下",
          state: "CHANGES_REQUESTED",
          html_url: "javascript:alert(1)",
          submitted_at: "2026-10-01T10:00:20Z",
        },
        {
          id: 32,
          user: { login: "bob" },
          body: "",
          state: "PENDING",
          submitted_at: "2026-10-01T10:00:30Z",
        },
      ],
    });
    const client = fake.client();
    const service = {
      client: () => client,
      repository: () => ({ owner: "octo", name: "repo" }),
      credentials: { noteSuccess() {}, noteFailure() {} },
      now: () => 0,
    } as unknown as GithubService;
    const forge = new GithubForge(service);
    const conversation = await forge.conversation(
      { host: "github.com", owner: "octo", name: "repo" },
      3,
    );
    expect(conversation.pollIntervalMs).toBe(75_000);
    expect(
      conversation.items.map((item) => [item.id, item.kind, item.author]),
    ).toEqual([
      ["r21", "comment", "ci[bot]"],
      ["c11", "comment", "alice"],
      ["v31", "review", "bob"],
    ]);
    expect(conversation.items[2]).toMatchObject({
      state: "changes_requested",
      url: "",
    });
  });
});

describe("Gitea", () => {
  let fake: FakeGitea;
  let forge: GiteaForge;
  const repo = {
    host: "127.0.0.1",
    owner: FAKE_GITEA.owner,
    name: FAKE_GITEA.repo,
  };
  beforeEach(async () => {
    fake = await startFakeGitea();
    forge = new GiteaForge({
      apiBase: fake.apiBase,
      token: async () => FAKE_GITEA.token,
    });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("评论与评审按时间排；结论统一写法；草稿丢掉；轮询间隔取响应头", async () => {
    fake.comments.set(4, [
      { id: 7, login: "alice", body: "第一条", at: 20 },
      { id: 8, login: "dev-bot[bot]", body: "机器人", at: 40 },
    ]);
    fake.reviews.set(4, [
      { id: 3, login: "bob", body: "通过", state: "APPROVED", at: 30 },
      { id: 4, login: "bob", body: "", state: "PENDING", at: 50 },
      { id: 5, login: "carol", body: "改", state: "REQUEST_CHANGES", at: 60 },
    ]);
    const conversation = await forge.conversation(repo, 4);
    expect(conversation.pollIntervalMs).toBe(90_000);
    expect(
      conversation.items.map((item) => [item.id, item.kind, item.state]),
    ).toEqual([
      ["c7", "comment", null],
      ["v3", "review", "approved"],
      ["c8", "comment", null],
      ["v5", "review", "changes_requested"],
    ]);
    expect(conversation.items[0]?.url).toContain("#issuecomment-7");
  });

  it("没有讨论是空列表，没有的 PR 编号被拒绝", async () => {
    expect((await forge.conversation(repo, 9)).items).toEqual([]);
    await expect(forge.conversation(repo, 0)).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});

describe("GitLab", () => {
  it("系统备注丢掉；链接由 MR 地址和备注编号拼出；轮询间隔取响应头", async () => {
    const tape = replay(["merge-requests", "notes"]);
    const forge = new GitlabForge({
      apiBase: GITLAB_FIXTURE.apiBase,
      token: async () => GITLAB_FIXTURE.token,
      fetch: tape.fetch,
    });
    const conversation = await forge.conversation(GITLAB_FIXTURE.repo, 12);
    expect(conversation.pollIntervalMs).toBe(120_000);
    expect(conversation.items).toEqual([
      {
        id: "c9002",
        kind: "comment",
        author: "carol",
        body: "这里少了空值判断",
        state: null,
        url: "https://gitlab.example.test/acme/app/-/merge_requests/12#note_9002",
        createdAtMs: Date.parse("2026-10-02T12:05:00.000Z"),
      },
      {
        id: "c9003",
        kind: "comment",
        author: "gitlab-bot",
        body: "pipeline summary",
        state: null,
        url: "https://gitlab.example.test/acme/app/-/merge_requests/12#note_9003",
        createdAtMs: Date.parse("2026-10-02T12:06:00.000Z"),
      },
    ]);
  });
});
