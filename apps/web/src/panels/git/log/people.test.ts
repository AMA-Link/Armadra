import { describe, expect, it } from "vitest";
import type { GitLogCommit } from "@armadra/shared";

import { agentOf, commitAgents, githubAccountId, initials } from "./people";

const commit = (overrides: Partial<GitLogCommit> = {}): GitLogCommit => ({
  repositoryPath: ".",
  oid: "a".repeat(40),
  parents: [],
  subject: "feat: x",
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-11-01T00:00:00Z",
  committerTime: "2026-11-01T00:00:00Z",
  refs: [],
  ...overrides,
});

describe("提交里的 Agent（#927 B3）", () => {
  it("认得内置 Agent 的常见署名", () => {
    expect(
      agentOf({ name: "Claude", email: "noreply@anthropic.com" })?.id,
    ).toBe("claude");
    expect(agentOf({ name: "Codex", email: "codex@openai.com" })?.id).toBe(
      "codex",
    );
    expect(
      agentOf({
        name: "Copilot",
        email: "198982749+Copilot@users.noreply.github.com",
      })?.id,
    ).toBe("copilot");
  });

  it("其它机器人照原文显示，普通人不算", () => {
    expect(agentOf({ name: "gemini-code-assist[bot]", email: "" })).toEqual({
      id: null,
      label: "gemini-code-assist[bot]",
    });
    expect(agentOf({ name: "Bob", email: "bob@example.invalid" })).toBeNull();
    // 「pi」这种短词不能单独算 Agent。
    expect(
      agentOf({ name: "Pi Wang", email: "pi@example.invalid" }),
    ).toBeNull();
  });

  it("作者本人排第一，尾注按顺序，同一家只留一次；老 core 没有 coAuthors", () => {
    expect(commitAgents(commit())).toEqual([]);
    const marks = commitAgents(
      commit({
        authorName: "codex[bot]",
        coAuthors: [
          { name: "Claude", email: "noreply@anthropic.com" },
          { name: "Codex", email: "codex@openai.com" },
          { name: "Bob", email: "bob@example.invalid" },
        ],
      }),
    );
    expect(marks.map((mark) => mark.id)).toEqual(["codex", "claude"]);
  });
});

describe("GitHub 账号 id 与首字母", () => {
  it("只从带 id 的 noreply 邮箱取 id", () => {
    expect(githubAccountId("12345+octo@users.noreply.github.com")).toBe(12345);
    expect(githubAccountId("octo@users.noreply.github.com")).toBeNull();
    expect(githubAccountId("ada@example.invalid")).toBeNull();
  });

  it("首字母：两段取各自首字，中文取前两个字", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("owlbay")).toBe("OW");
    expect(initials("张三丰")).toBe("张三");
    expect(initials("  ")).toBe("?");
  });
});
