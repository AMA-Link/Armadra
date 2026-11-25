import { describe, expect, it } from "vitest";
import type { AgentInfo, Conversation } from "@armadra/shared";

import { resumeNodeInput, resumeTarget } from "./conversations";

/** 历史对话怎么接回：终端的 `--resume` 行，或经 ACP 的 `session/load`（#997 批 2）。 */

const conversation = (provider: string): Conversation =>
  ({
    provider,
    sessionId: "11111111-2222-3333-4444-555555555555",
    title: "修一个 bug",
    cwd: "/work/app",
    updatedAt: "2026-11-20T10:00:00.000Z",
    bytes: 0,
  }) as Conversation;

const agent = (
  id: string,
  acp?: { installed: boolean; resume: "load" | "resume" | "none" },
): Pick<AgentInfo, "id" | "acp"> =>
  ({
    id,
    ...(acp === undefined
      ? {}
      : { acp: { support: "native", program: id, ...acp } }),
  }) as never;

describe("resumeTarget", () => {
  it("有终端 resume 能力位的 CLI 照旧走 --resume 行", () => {
    const target = resumeTarget(conversation("claude"), []);
    expect(target).toEqual({
      kind: "terminal",
      command: expect.stringContaining("--resume"),
    });
  });

  it("没有终端 resume、ACP 装了且能接回的 CLI（agy）走 ACP", () => {
    expect(
      resumeTarget(conversation("agy"), [
        agent("agy", { installed: true, resume: "load" }),
      ]),
    ).toEqual({ kind: "acp" });
  });

  it("ACP 没装、不能接回、或根本没有这家：接不回，答 null（调用方把那一行禁掉）", () => {
    expect(
      resumeTarget(conversation("agy"), [
        agent("agy", { installed: false, resume: "load" }),
      ]),
    ).toBeNull();
    expect(
      resumeTarget(conversation("agy"), [
        agent("agy", { installed: true, resume: "none" }),
      ]),
    ).toBeNull();
    expect(resumeTarget(conversation("agy"), [])).toBeNull();
    expect(resumeTarget(conversation("agy"), [agent("agy")])).toBeNull();
  });
});

describe("resumeNodeInput", () => {
  it("ACP：节点记着 CLI 的会话 id，驱动是 acp，与「接管会话」同一条路", () => {
    const input = resumeNodeInput(
      conversation("agy"),
      { kind: "acp" },
      "/work",
    );
    expect(input).toEqual({
      title: "修一个 bug",
      data: {
        kind: "terminal",
        cwd: "/work/app",
        agent: {
          id: "agy",
          driver: "acp",
          sessionId: "11111111-2222-3333-4444-555555555555",
        },
      },
    });
  });

  it("ACP：cwd 为空、或在工作空间之外时不写这个字段（空 cwd 会让会话起不来）", () => {
    const at = (cwd: string, root?: string) =>
      (
        resumeNodeInput({ ...conversation("agy"), cwd }, { kind: "acp" }, root)
          .data as { cwd?: string }
      ).cwd;
    expect(at("", "/work")).toBeUndefined();
    expect(at("/elsewhere/app", "/work")).toBeUndefined();
    expect(at("/work/app", "/work")).toBe("/work/app");
    expect(at("/work", "/work")).toBe("/work");
    // 没有工作空间根（还没打开）：不带。
    expect(at("/work/app")).toBeUndefined();
  });

  it("终端：启动行在建节点时就定了", () => {
    const input = resumeNodeInput(conversation("claude"), {
      kind: "terminal",
      command: "claude --resume x",
    });
    expect(input.data).toEqual({
      kind: "terminal",
      cwd: "/work/app",
      agent: {
        id: "claude",
        initialCommand: "claude --resume x",
        pendingLaunch: { command: "claude --resume x", after: [] },
      },
    });
  });
});
