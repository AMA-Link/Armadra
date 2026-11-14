import type { BuiltinAgentId, GitLogCommit } from "@armadra/shared";

/**
 * 提交里的人与 Agent（#927 B3）。
 *
 * 只认两样东西：作者本人，与提交信息里的 `Co-authored-by:` 尾注（core 已经拆成
 * `coAuthors`）。不去猜「这段代码像是 Agent 写的」——标记必须能指着提交里的
 * 一行字说清楚来源。
 */

export interface AgentMark {
  /** 内置 Agent 的 id，用它的标识色与名字；认不出是哪家时为 `null`。 */
  readonly id: BuiltinAgentId | null;
  /** 显示名：内置的用注册表里的名字，其余照尾注原文。 */
  readonly label: string;
}

/** 按顺序匹配：先认内置 Agent，再认常见的「这是个机器人」写法。 */
const BUILTIN: readonly [BuiltinAgentId, RegExp][] = [
  ["claude", /\bclaude\b|@anthropic\.com$/i],
  ["codex", /\bcodex\b|@openai\.com$/i],
  ["copilot", /\bcopilot\b/i],
  ["opencode", /\bopencode\b/i],
  ["omp", /\boh-my-pi\b|\bomp\b/i],
  ["pi", /\bpi[- ](?:coding[- ])?agent\b/i],
  ["ama", /\bama\b|@armadra\.(?:com|dev)$/i],
];
const OTHER = /\bgemini\b|\bcursor\b|\baider\b|\bdevin\b|\[bot\]|\bai agent\b/i;

/** 一个署名是不是 Agent；不是返回 `null`。 */
export function agentOf(person: {
  name: string;
  email: string;
}): AgentMark | null {
  const text = `${person.name} ${person.email}`;
  for (const [id, pattern] of BUILTIN) {
    if (pattern.test(person.name) || pattern.test(person.email)) {
      return { id, label: "" };
    }
  }
  if (OTHER.test(text)) {
    return { id: null, label: person.name.trim() || person.email.trim() };
  }
  return null;
}

/**
 * 这个提交里的 Agent：作者本人是 Agent 的排第一，然后是尾注里的，按出现顺序、
 * 同一家只留一次。
 */
export function commitAgents(commit: GitLogCommit): AgentMark[] {
  const marks: AgentMark[] = [];
  const seen = new Set<string>();
  for (const person of [
    { name: commit.authorName, email: commit.authorEmail },
    ...(commit.coAuthors ?? []),
  ]) {
    const mark = agentOf(person);
    if (!mark) continue;
    const key = mark.id ?? mark.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push(mark);
  }
  return marks;
}

/**
 * GitHub noreply 邮箱里的账号 id：`12345+login@users.noreply.github.com`。
 * 旧式的 `login@users.noreply.github.com` 没有 id，返回 `null`——拿登录名换 id
 * 要一次带额度的 API 请求，这里不做。
 */
export function githubAccountId(email: string): number | null {
  const match = /^(\d+)\+[^@\s]+@users\.noreply\.github\.com$/i.exec(
    email.trim(),
  );
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 头像里的字：取名字前两段的首字（中文名取前两个字），都没有就 `?`。 */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "?";
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (/^[\p{Script=Han}]/u.test(trimmed)) {
    return Array.from(trimmed).slice(0, 2).join("");
  }
  const letters =
    words.length > 1
      ? [words[0]!, words[1]!].map((word) => Array.from(word)[0]!)
      : Array.from(words[0] ?? trimmed).slice(0, 2);
  return letters.join("").toUpperCase();
}
