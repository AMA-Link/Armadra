import { describe, expect, it } from "vitest";

import { intakeCandidateSchema, intakeSourceSchema } from "./api";
import { dispatchTaskSchema } from "./api";

/**
 * 任务行的解析（契约 §15.7、§90）：旧 core 不答账本字段时取缺省；将来的 core 多
 * 一个阶段值时，这一行当作没有阶段，不让整张列表解析失败。
 */

const ROW = {
  taskId: "s1:t1",
  coordinatorNodeId: "lead",
  runnerId: "codex",
  nodeId: "m1",
  status: "running",
  startedAt: "2026-11-02T08:00:00.000Z",
  endedAt: null,
};

describe("dispatchTaskSchema", () => {
  it("keeps a known stage", () => {
    expect(
      dispatchTaskSchema.parse({ ...ROW, stage: "person/review" }).stage,
    ).toBe("person/review");
  });

  it("reads an unknown stage from a newer core as no stage", () => {
    expect(
      dispatchTaskSchema.parse({ ...ROW, stage: "person/later" }).stage,
    ).toBeNull();
  });

  it("defaults the ledger fields an older core does not send", () => {
    expect(dispatchTaskSchema.parse(ROW).stage).toBeNull();
  });

  it("reads the coordinator's reply, and a missing or unknown one as none", () => {
    const reply = {
      purpose: "attention",
      text: "用哪个账号？",
      at: "2026-10-04T08:00:00.000Z",
      read: false,
    };
    expect(dispatchTaskSchema.parse({ ...ROW, reply }).reply).toEqual(reply);
    expect(dispatchTaskSchema.parse(ROW).reply).toBeNull();
    expect(
      dispatchTaskSchema.parse({ ...ROW, reply: { ...reply, purpose: "chat" } })
        .reply,
    ).toBeNull();
  });
});

describe("来源与候选的解析（契约 §104.7）", () => {
  const SOURCE = {
    id: "s1",
    coordinatorNodeId: "lead",
    repo: "github.com/acme/app",
    kinds: ["issue", "mail"],
    mode: "later",
  };

  it("drops unknown kinds, reads an unknown mode as observe and defaults the rest", () => {
    const parsed = intakeSourceSchema.parse(SOURCE);
    expect(parsed.kinds).toEqual(["issue"]);
    expect(parsed.mode).toBe("observe");
    expect(parsed.allow).toEqual([]);
    expect(parsed.rulesPresent).toBe(false);
    expect(parsed.stats.window).toBe(20);
  });

  it("reads a candidate with unknown verdict, mode or review as undecided", () => {
    const parsed = intakeCandidateSchema.parse({
      id: "c1",
      sourceId: "s1",
      kind: "issue",
      repo: "r",
      number: 3,
      title: "t",
      seenAt: "2026-11-06T08:00:00.000Z",
      verdict: "maybe",
      modeAtVerdict: "later",
      review: "meh",
    });
    expect(parsed.verdict).toBeNull();
    expect(parsed.modeAtVerdict).toBeNull();
    expect(parsed.review).toBeNull();
    expect(parsed.outcome).toBeNull();
  });
});
