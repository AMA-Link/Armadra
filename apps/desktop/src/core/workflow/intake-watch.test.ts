import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import type { ForgeService } from "../forge/service";
import {
  ForgeError,
  type Forge,
  type ForgeConversationItem,
  type ForgeIssue,
  type ForgePull,
} from "../forge/types";
import {
  type IntakeCandidate,
  type IntakeSource,
  getSource,
  listCandidates,
  recordVerdict,
  saveSource,
} from "./intake";
import {
  IntakeWatch,
  MAX_BACKOFF_MS,
  MAX_CANDIDATES_PER_HOUR,
  MIN_SOURCE_POLL_MS,
} from "./intake-watch";
import { RULES_PATH } from "./rules";
import { recordTaskStart } from "./task-runs";
import { bindThread } from "./threads";

/**
 * 来源的轮询（契约 §104.2）：用脚本化的 forge 代替远端，断言新线程出候选、机器人
 * 与草稿不出、游标回退不重复、已认领只推游标、规则缺失不推游标、限流停下且游标不推、
 * 重新提起只认判定之后允许名单里的评论、一线程最多 3 次、单来源失败只退避自己。
 */

const REPO = "github.com/acme/app";
const T0 = 1_800_000_000_000;

function issue(
  number: number,
  createdAtMs: number,
  extra: Partial<ForgeIssue> = {},
): ForgeIssue {
  return {
    number,
    title: `issue ${number}`,
    body: "SECRET-BODY",
    state: "open",
    author: "alice",
    labels: [],
    commentCount: 0,
    url: `https://github.com/acme/app/issues/${number}`,
    createdAtMs,
    updatedAtMs: createdAtMs,
    closedAtMs: null,
    ...extra,
  };
}

function pull(
  number: number,
  createdAtMs: number,
  extra: Partial<ForgePull> = {},
): ForgePull {
  return {
    number,
    title: `pull ${number}`,
    body: "",
    state: "open",
    draft: false,
    author: "alice",
    baseRef: "main",
    headRef: "feat",
    headSha: "a".repeat(40),
    mergeable: "mergeable",
    url: `https://github.com/acme/app/pull/${number}`,
    createdAtMs,
    updatedAtMs: createdAtMs,
    mergedAtMs: null,
    autoMerge: false,
    fromFork: false,
    ...extra,
  };
}

function comment(
  id: string,
  author: string,
  createdAtMs: number,
): ForgeConversationItem {
  return {
    id,
    kind: "comment",
    author,
    body: "please take this",
    state: null,
    url: "",
    createdAtMs,
  };
}

class ScriptedForge {
  issues: ForgeIssue[] = [];
  pulls: ForgePull[] = [];
  comments = new Map<number, ForgeConversationItem[]>();
  failure: ForgeError | undefined;
  pullFailure: ForgeError | undefined;
  conversationReads: number[] = [];
  /** 列表响应的 `x-poll-interval`（毫秒）。 */
  pollIntervalMs: number | undefined;
  pagesRead = 0;

  private page<T extends { updatedAtMs: number }>(
    list: T[],
    page: number,
    limit: number,
  ): { items: T[]; nextCursor: string | null } {
    const sorted = [...list].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const items = sorted.slice((page - 1) * limit, page * limit);
    return {
      items,
      nextCursor: sorted.length > page * limit ? String(page + 1) : null,
      ...(this.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.pollIntervalMs }),
    };
  }

  readonly remote = {
    listIssues: async (
      _repo: unknown,
      options: { page: number; limit: number },
    ) => {
      this.pagesRead += 1;
      if (this.failure !== undefined) throw this.failure;
      return this.page(this.issues, options.page, options.limit);
    },
    listPulls: async (
      _repo: unknown,
      options: { page: number; limit: number },
    ) => {
      this.pagesRead += 1;
      if (this.pullFailure !== undefined) throw this.pullFailure;
      return this.page(this.pulls, options.page, options.limit);
    },
    conversation: async (_repo: unknown, number: number) => {
      this.conversationReads.push(number);
      return { items: this.comments.get(number) ?? [], pollIntervalMs: null };
    },
  } as unknown as Forge;

  readonly service = {
    forgeFor: () => this.remote,
  } as unknown as ForgeService;
}

let fixture: AgentFixture;
let lead: string;
let clock: number;
let remote: ScriptedForge;
let watch: IntakeWatch;
let seen: string[];

function writeRules(text = "- 接：bug\n"): void {
  const path = join(fixture.directory, RULES_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function source(
  kinds: string[] = ["issue"],
  allow: string[] = ["alice"],
  repo = REPO,
): IntakeSource {
  return saveSource(
    fixture.database,
    {
      coordinatorNodeId: lead,
      workspaceId: fixture.workspaceId,
      repo,
      kinds,
      mode: "observe",
      allow,
      enabled: true,
    },
    { present: false, remote: false, hash: "", text: "", truncated: false },
    clock,
  );
}

function candidates(): IntakeCandidate[] {
  return listCandidates(fixture.database, {
    coordinatorNodeIds: [lead],
    limit: 50,
    order: "oldest",
  }).candidates;
}

beforeEach(() => {
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
  clock = T0;
  remote = new ScriptedForge();
  seen = [];
  writeRules();
  watch = new IntakeWatch({
    database: fixture.database,
    forge: () => remote.service,
    clock: () => clock,
    onCandidate: (candidate) => seen.push(candidate.id),
  });
});

afterEach(() => fixture.close());

describe("new threads", () => {
  it("raises a candidate for a new thread once, and not for bots, drafts or threads older than the source", async () => {
    const from = source(["issue", "pull"]);
    remote.issues = [
      issue(1, T0 - 3_600_000, { updatedAtMs: T0 + 500 }),
      issue(2, T0 + 1_000),
      issue(3, T0 + 1_100, { author: "renovate[bot]" }),
      issue(4, T0 + 1_200, { author: "carol" }),
    ];
    remote.pulls = [pull(5, T0 + 1_300, { draft: true }), pull(6, T0 + 1_400)];
    clock = T0 + 10_000;
    expect(await watch.tick()).toBe(3);
    expect(
      candidates().map((row) => [row.kind, row.number, row.authorized]),
    ).toEqual([
      ["issue", 2, true],
      ["issue", 4, false],
      ["pull", 6, true],
    ]);
    expect(seen).toHaveLength(3);
    expect(getSource(fixture.database, from.id)?.cursorAt).toBe(T0 + 1_400);
    // 同一段响应再读一遍（游标回退 5 秒，窗口里还有这些）：不出第二条。
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(0);
    expect(candidates()).toHaveLength(3);
    // 草稿转正：更新时间变了，它还没出过候选，这时才出。
    remote.pulls = [
      pull(5, T0 + 1_300, { updatedAtMs: T0 + 200_000 }),
      pull(6, T0 + 1_400),
    ];
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(1);
    expect(candidates().at(-1)).toMatchObject({ kind: "pull", number: 5 });
    // 候选表不存正文。
    expect(
      JSON.stringify(
        fixture.database.prepare("SELECT * FROM router_intake").all(),
      ),
    ).not.toContain("SECRET-BODY");
  });

  it("does not backfill the new repository when a source changes repo", async () => {
    const from = source();
    clock = T0 + 3_600_000;
    const moved = saveSource(
      fixture.database,
      {
        id: from.id,
        coordinatorNodeId: lead,
        workspaceId: fixture.workspaceId,
        repo: "github.com/acme/other",
        kinds: ["issue"],
        mode: "observe",
        allow: ["alice"],
        enabled: true,
      },
      { present: false, remote: false, hash: "", text: "", truncated: false },
      clock,
    );
    expect(moved).toMatchObject({ cursorAt: clock, createdAt: clock });
    // 新仓库里换仓库之前建的线程，之后才有人动过：不回灌。
    remote.issues = [
      issue(3, T0 + 1_000, { updatedAtMs: clock + 5_000 }),
      issue(4, clock + 6_000),
    ];
    clock += 10_000;
    expect(await watch.tick()).toBe(1);
    expect(candidates().map((row) => [row.repo, row.number])).toEqual([
      ["github.com/acme/other", 4],
    ]);
  });

  it("only advances the cursor for a claimed thread", async () => {
    const from = source();
    recordTaskStart(fixture.database, {
      taskId: "t1",
      coordinatorNodeId: lead,
      runnerId: "codex",
      nodeId: lead,
      now: T0,
    });
    bindThread(
      fixture.database,
      "t1",
      { kind: "issue", repo: REPO, number: 2, own: false, url: "" },
      T0,
    );
    remote.issues = [issue(2, T0 + 1_000)];
    clock = T0 + 10_000;
    expect(await watch.tick()).toBe(0);
    expect(candidates()).toEqual([]);
    expect(getSource(fixture.database, from.id)?.cursorAt).toBe(T0 + 1_000);
  });

  it("skips a source without a rules file and keeps its cursor", async () => {
    const from = source();
    rmSync(join(fixture.directory, RULES_PATH));
    remote.issues = [issue(2, T0 + 1_000)];
    clock = T0 + 10_000;
    expect(await watch.tick()).toBe(0);
    expect(remote.pagesRead).toBe(0);
    expect(getSource(fixture.database, from.id)?.cursorAt).toBe(T0);
    writeRules();
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(1);
  });

  it("stops at 20 candidates an hour without advancing the cursor", async () => {
    const from = source();
    remote.issues = Array.from(
      { length: MAX_CANDIDATES_PER_HOUR + 5 },
      (_, index) => issue(index + 1, T0 + 1_000 + index),
    );
    clock = T0 + 10_000;
    expect(await watch.tick()).toBe(MAX_CANDIDATES_PER_HOUR);
    expect(getSource(fixture.database, from.id)?.cursorAt).toBe(T0);
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(0);
    // 一小时之后接着出，游标这时才推。
    clock += 3_600_000;
    expect(await watch.tick()).toBe(5);
    expect(getSource(fixture.database, from.id)?.cursorAt).toBe(
      T0 + 1_000 + MAX_CANDIDATES_PER_HOUR + 4,
    );
  });
});

describe("raising again", () => {
  it("only counts comments after the verdict by someone on the allow list, at most three times", async () => {
    source(["issue"], ["alice", "bob"]);
    remote.issues = [issue(7, T0 + 1_000, { author: "carol" })];
    clock = T0 + 10_000;
    await watch.tick();
    const [first] = candidates();
    expect(first).toMatchObject({
      authorized: false,
      request: { by: "carol" },
    });
    // 没判定之前，有人评论也不提起。
    remote.issues = [
      issue(7, T0 + 1_000, { author: "carol", updatedAtMs: T0 + 20_000 }),
    ];
    remote.comments.set(7, [comment("c1", "alice", T0 + 15_000)]);
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(0);
    expect(remote.conversationReads).toEqual([]);
    recordVerdict(
      fixture.database,
      first!.id,
      { verdict: "skip", reason: "没授权", rulesHash: "", mode: "observe" },
      T0 + 30_000,
    );
    // 判定之前的评论与名单外的人、机器人的评论都不算。
    remote.issues = [
      issue(7, T0 + 1_000, { author: "carol", updatedAtMs: T0 + 40_000 }),
    ];
    remote.comments.set(7, [
      comment("c1", "alice", T0 + 15_000),
      comment("c2", "dave", T0 + 35_000),
      comment("c3", "alice[bot]", T0 + 36_000),
    ]);
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(0);
    expect(remote.conversationReads).toEqual([7]);
    // 同一个更新时刻不再读讨论。
    clock += MIN_SOURCE_POLL_MS;
    await watch.tick();
    expect(remote.conversationReads).toEqual([7]);
    // 名单里的人在判定之后评论：出新候选，版本是评论 id。
    remote.issues = [
      issue(7, T0 + 1_000, { author: "carol", updatedAtMs: T0 + 50_000 }),
    ];
    remote.comments.set(7, [
      ...(remote.comments.get(7) ?? []),
      comment("c4", "Bob", T0 + 45_000),
    ]);
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(1);
    const raised = candidates().at(-1);
    expect(raised).toMatchObject({
      id: `intake:${REPO}#7:issue:c4`,
      authorized: true,
      request: { by: "Bob", via: "comment", commentId: "c4", at: T0 + 45_000 },
    });
    recordVerdict(
      fixture.database,
      raised!.id,
      { verdict: "skip", reason: "不接", rulesHash: "", mode: "observe" },
      clock,
    );
    // 第三次。
    remote.issues = [
      issue(7, T0 + 1_000, { author: "carol", updatedAtMs: clock + 20_000 }),
    ];
    remote.comments.set(7, [comment("c5", "alice", clock + 10_000)]);
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(1);
    recordVerdict(
      fixture.database,
      candidates().at(-1)!.id,
      { verdict: "skip", reason: "不接", rulesHash: "", mode: "observe" },
      clock,
    );
    // 到了 3 条，之后只有人手动处理。
    remote.issues = [
      issue(7, T0 + 1_000, { author: "carol", updatedAtMs: clock + 20_000 }),
    ];
    remote.comments.set(7, [comment("c6", "alice", clock + 10_000)]);
    const reads = remote.conversationReads.length;
    clock += MIN_SOURCE_POLL_MS;
    expect(await watch.tick()).toBe(0);
    expect(remote.conversationReads).toHaveLength(reads);
    expect(candidates()).toHaveLength(3);
  });
});

describe("interval", () => {
  it("waits for a larger x-poll-interval from the list response", async () => {
    source();
    remote.pollIntervalMs = 5 * MIN_SOURCE_POLL_MS;
    clock = T0 + 10_000;
    await watch.tick();
    const pages = remote.pagesRead;
    clock += MIN_SOURCE_POLL_MS;
    await watch.tick();
    expect(remote.pagesRead).toBe(pages);
    clock += 4 * MIN_SOURCE_POLL_MS;
    await watch.tick();
    expect(remote.pagesRead).toBe(pages + 1);
  });
});

describe("failures", () => {
  it("backs off only the failing source and caps the backoff at 10 minutes", async () => {
    source(["issue"], ["alice"], REPO);
    source(["pull"], ["alice"], "github.com/acme/other");
    remote.pullFailure = new ForgeError("unavailable", "RATE_LIMITED");
    remote.issues = [issue(2, T0 + 1_000)];
    clock = T0 + 10_000;
    expect(await watch.tick()).toBe(1);
    expect(watch.failing()).toBe(1);
    // 第一次失败退避 1 倍、第二次 2 倍：再失败一次之后，下一个间隔只读好的那个。
    clock += MIN_SOURCE_POLL_MS;
    await watch.tick();
    const pages = remote.pagesRead;
    clock += MIN_SOURCE_POLL_MS;
    await watch.tick();
    expect(remote.pagesRead).toBe(pages + 1);
    for (let round = 0; round < 8; round += 1) {
      clock += MAX_BACKOFF_MS;
      await watch.tick();
    }
    expect(watch.failing()).toBe(1);
    remote.pullFailure = undefined;
    clock += MAX_BACKOFF_MS;
    await watch.tick();
    expect(watch.failing()).toBe(0);
  });
});
