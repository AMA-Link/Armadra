import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import {
  CANDIDATE_RETENTION_MS,
  MAX_SOURCES,
  STATS_WINDOW,
  type IntakeSource,
  advanceCursor,
  candidateId,
  claimedBy,
  deleteSource,
  getCandidate,
  insertCandidate,
  isAllowed,
  listCandidates,
  markDispatched,
  markRefused,
  normalizeReason,
  pruneCandidates,
  recordVerdict,
  reviewCandidate,
  saveSource,
  sourceStats,
  sourcesForBoard,
  threadVersion,
} from "./intake";
import type { RulesRead } from "./rules";
import { finishTask, recordTaskStart } from "./task-runs";
import { POLL_RETENTION_MS, bindThread } from "./threads";

/** 来源与候选的账（契约 §104.1–§104.2）。 */

const REPO = "github.com/acme/app";
const T0 = 1_800_000_000_000;
const RULES: RulesRead = {
  present: true,
  remote: false,
  hash: "0123456789abcdef",
  text: "接 bug",
  truncated: false,
};
const NO_RULES: RulesRead = {
  present: false,
  remote: false,
  hash: "",
  text: "",
  truncated: false,
};

let fixture: AgentFixture;
let lead: string;

beforeEach(() => {
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
});

afterEach(() => fixture.close());

function source(extra: Partial<Parameters<typeof saveSource>[1]> = {}) {
  return saveSource(
    fixture.database,
    {
      coordinatorNodeId: lead,
      workspaceId: fixture.workspaceId,
      repo: REPO,
      kinds: ["issue"],
      mode: "observe",
      allow: [],
      enabled: true,
      ...extra,
    },
    RULES,
    T0,
  );
}

function candidate(
  from: IntakeSource,
  number: number,
  by = "Alice",
  nowMs = T0,
) {
  return insertCandidate(
    fixture.database,
    {
      source: from,
      kind: "issue",
      number,
      version: threadVersion(T0 + number),
      title: `  标题\n第 ${number} 个  `,
      author: by,
      url: `https://github.com/acme/app/issues/${number}`,
      request: { by, via: "thread", at: T0 + number },
      sourceAt: T0 + number,
    },
    nowMs,
  );
}

describe("sources", () => {
  it("creates an observe source with the cursor at now and lower-cased allow list", () => {
    const created = source({ allow: [" Alice ", "alice", "BOB"] });
    expect(created).toMatchObject({
      repo: REPO,
      kinds: ["issue"],
      mode: "observe",
      allow: ["alice", "bob"],
      rulesHash: "",
      enabled: true,
      cursorAt: T0,
    });
    expect(isAllowed(created, "ALICE")).toBe(true);
    expect(isAllowed(created, "carol")).toBe(false);
    expect(sourcesForBoard(fixture.database, fixture.boardId)).toHaveLength(1);
  });

  it("refuses auto without an allow list, unconfirmed rules, changed rules or a remote workspace", () => {
    const created = source();
    const save = (extra: object, rules: RulesRead = RULES) =>
      saveSource(
        fixture.database,
        {
          id: created.id,
          coordinatorNodeId: lead,
          workspaceId: fixture.workspaceId,
          repo: REPO,
          kinds: ["issue"],
          mode: "auto",
          allow: ["alice"],
          enabled: true,
          ...extra,
        },
        rules,
        T0 + 1,
      );
    expect(() => save({ allow: [] })).toThrow(/允许名单/);
    expect(() => save({})).toThrow(/确认规则/);
    expect(() => save({ confirmRules: true }, NO_RULES)).toThrow(
      /没有规则文件/,
    );
    expect(() =>
      save({ confirmRules: true }, { ...NO_RULES, remote: true }),
    ).toThrow(/远端/);
    const auto = save({ confirmRules: true });
    expect(auto).toMatchObject({ mode: "auto", rulesHash: RULES.hash });
    expect(() => save({}, { ...RULES, hash: "ffffffffffffffff" })).toThrow(
      /重新确认/,
    );
    // 切回 observe 随时可以。
    expect(
      save({ mode: "observe" }, { ...RULES, hash: "ffffffffffffffff" }).mode,
    ).toBe("observe");
  });

  it("rejects bad kinds and modes, duplicates and the eleventh source", () => {
    expect(() => source({ kinds: [] })).toThrow(/kinds/);
    expect(() => source({ kinds: ["issue", "wiki"] })).toThrow(/kinds/);
    expect(() => source({ mode: "fast" })).toThrow(/mode/);
    source();
    expect(() => source()).toThrow(/已经有/);
    for (let index = 1; index < MAX_SOURCES; index += 1) {
      source({ repo: `github.com/acme/r${index}` });
    }
    expect(() => source({ repo: "github.com/acme/extra" })).toThrowError(
      expect.objectContaining({ code: "sources_full", status: 409 }),
    );
  });

  it("advances the cursor only forward and deletes with its candidates", () => {
    const created = source();
    advanceCursor(fixture.database, created.id, T0 + 10);
    advanceCursor(fixture.database, created.id, T0 + 5);
    expect(
      sourcesForBoard(fixture.database, fixture.boardId)[0]?.cursorAt,
    ).toBe(T0 + 10);
    candidate(created, 1);
    fixture.database.exec("PRAGMA foreign_keys = ON");
    expect(deleteSource(fixture.database, created.id)).toBe(true);
    expect(deleteSource(fixture.database, created.id)).toBe(false);
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM router_intake").get(),
    ).toEqual({ n: 0 });
  });
});

describe("candidates", () => {
  it("has a deterministic id and is written once", () => {
    const from = source({ allow: ["alice"] });
    const first = candidate(from, 3);
    expect(first).toEqual({
      inserted: true,
      id: candidateId("issue", REPO, 3, threadVersion(T0 + 3)),
    });
    expect(first.id).toBe(`intake:${REPO}#3:issue:${(T0 + 3).toString(36)}`);
    expect(candidate(from, 3).inserted).toBe(false);
    expect(getCandidate(fixture.database, first.id)).toMatchObject({
      title: "标题 第 3 个",
      author: "Alice",
      authorized: true,
      request: { by: "Alice", via: "thread", at: T0 + 3 },
      verdict: null,
    });
    expect(
      getCandidate(fixture.database, candidate(from, 4, "carol").id),
    ).toMatchObject({ authorized: false });
  });

  it("records a verdict once and reviews it", () => {
    const from = source();
    const { id } = candidate(from, 1);
    expect(() => reviewCandidate(fixture.database, id, "agree", T0)).toThrow(
      /还没判定/,
    );
    const decided = recordVerdict(
      fixture.database,
      id,
      { verdict: "accept", reason: "是 bug", rulesHash: "h", mode: "observe" },
      T0 + 5,
    );
    expect(decided).toMatchObject({
      verdict: "accept",
      verdictReason: "是 bug",
      verdictAt: T0 + 5,
      rulesHash: "h",
      modeAtVerdict: "observe",
    });
    expect(() =>
      recordVerdict(
        fixture.database,
        id,
        { verdict: "skip", reason: "x", rulesHash: "", mode: "observe" },
        T0 + 6,
      ),
    ).toThrowError(expect.objectContaining({ code: "already_decided" }));
    expect(() =>
      recordVerdict(
        fixture.database,
        "intake:none",
        { verdict: "skip", reason: "x", rulesHash: "", mode: "observe" },
        T0 + 6,
      ),
    ).toThrowError(expect.objectContaining({ code: "candidate_not_found" }));
    expect(
      reviewCandidate(fixture.database, id, "disagree", T0 + 7),
    ).toMatchObject({ review: "disagree", reviewedAt: T0 + 7 });
    expect(reviewCandidate(fixture.database, id, null, T0 + 8)).toMatchObject({
      review: null,
      reviewedAt: null,
    });
  });

  it("normalizes the reason to one line of at most 100 characters", () => {
    expect(normalizeReason("  有\n复现\u0007步骤 ")).toBe("有 复现步骤");
    expect(() => normalizeReason("")).toThrow(/必填/);
    expect(() => normalizeReason(undefined)).toThrow(/必填/);
    expect(() => normalizeReason("字".repeat(101))).toThrow(/100/);
    expect(normalizeReason("字".repeat(100))).toHaveLength(100);
  });

  it("lists undecided oldest first and decided newest first", () => {
    const from = source();
    const ids = [1, 2, 3].map(
      (number) => candidate(from, number, "a", T0 + number).id,
    );
    recordVerdict(
      fixture.database,
      ids[1]!,
      { verdict: "skip", reason: "x", rulesHash: "", mode: "observe" },
      T0 + 9,
    );
    const open = listCandidates(fixture.database, {
      coordinatorNodeIds: [lead],
      decided: false,
      limit: 10,
      order: "oldest",
    });
    expect(open.total).toBe(2);
    expect(open.candidates.map((row) => row.id)).toEqual([ids[0], ids[2]]);
    const all = listCandidates(fixture.database, {
      coordinatorNodeIds: [lead],
      limit: 1,
      offset: 1,
    });
    expect(all.total).toBe(3);
    expect(all.candidates.map((row) => row.id)).toEqual([ids[1]]);
    expect(
      listCandidates(fixture.database, { coordinatorNodeIds: [], limit: 5 }),
    ).toEqual({ candidates: [], total: 0 });
  });

  it("counts the last 20 verdicts", () => {
    const from = source();
    for (let number = 1; number <= STATS_WINDOW + 2; number += 1) {
      const { id } = candidate(from, number);
      recordVerdict(
        fixture.database,
        id,
        {
          verdict: number % 2 === 0 ? "accept" : "skip",
          reason: "x",
          rulesHash: "",
          mode: "observe",
        },
        T0 + number,
      );
      if (number <= 2) reviewCandidate(fixture.database, id, "agree", T0);
      if (number === STATS_WINDOW + 2) {
        reviewCandidate(fixture.database, id, "disagree", T0);
      }
    }
    // 1、2 号是最早的两条，已经出了窗口。
    expect(sourceStats(fixture.database, from.id)).toEqual({
      decided: STATS_WINDOW,
      accepted: STATS_WINDOW / 2,
      agreed: 0,
      disagreed: 1,
      window: STATS_WINDOW,
    });
  });

  it("keeps dispatched candidates and prunes the rest after 90 days", () => {
    const from = source();
    const kept = candidate(from, 1).id;
    const dropped = candidate(from, 2).id;
    markDispatched(fixture.database, kept, "task-1", T0 + 1);
    markRefused(fixture.database, kept, "rules_changed");
    markRefused(fixture.database, dropped, "intake_observe");
    expect(getCandidate(fixture.database, kept)).toMatchObject({
      itemId: "task-1",
      dispatchedAt: T0 + 1,
      outcome: "dispatched",
    });
    expect(getCandidate(fixture.database, dropped)?.outcome).toBe(
      "refused:intake_observe",
    );
    expect(pruneCandidates(fixture.database, T0 + CANDIDATE_RETENTION_MS)).toBe(
      0,
    );
    expect(
      pruneCandidates(fixture.database, T0 + CANDIDATE_RETENTION_MS + 1),
    ).toBe(1);
    expect(getCandidate(fixture.database, kept)).toBeDefined();
    expect(getCandidate(fixture.database, dropped)).toBeUndefined();
  });
});

describe("claimedBy", () => {
  function item(taskId: string, number: number, kind: "issue" | "pull") {
    recordTaskStart(fixture.database, {
      taskId,
      coordinatorNodeId: lead,
      runnerId: "codex",
      nodeId: lead,
      now: T0,
    });
    bindThread(
      fixture.database,
      taskId,
      { kind, repo: REPO, number, own: false, url: "" },
      T0,
    );
  }

  it("answers a running item, one ended within 14 days, and nothing for older ones", () => {
    item("running", 7, "issue");
    expect(claimedBy(fixture.database, "issue", REPO, 7, T0)).toBe("running");
    // 种类、仓库、编号都要相等：70 号与同号的 PR 不算。
    expect(claimedBy(fixture.database, "pull", REPO, 7, T0)).toBeNull();
    expect(claimedBy(fixture.database, "issue", REPO, 70, T0)).toBeNull();
    expect(
      claimedBy(fixture.database, "issue", "github.com/acme/other", 7, T0),
    ).toBeNull();
    item("ended", 8, "issue");
    finishTask(fixture.database, "ended", "done", null, T0 + 1_000);
    expect(
      claimedBy(fixture.database, "issue", REPO, 8, T0 + POLL_RETENTION_MS),
    ).toBe("ended");
    expect(
      claimedBy(
        fixture.database,
        "issue",
        REPO,
        8,
        T0 + 1_000 + POLL_RETENTION_MS + 1,
      ),
    ).toBeNull();
  });
});
