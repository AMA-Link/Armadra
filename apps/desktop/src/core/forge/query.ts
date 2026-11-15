/**
 * 列表搜索框里的限定词串（契约 §112.1），如 `is:open label:core -author:x sync`。
 *
 * GitHub 把整条（去掉能越出仓库的那几个）原样交给它的搜索；Gitea / GitLab 没有
 * 这套语法，按键拆成各自的列表参数，拆不出的原样回报给页面（`unsupported`）。
 * 这里只做词法：引号包住的值（`label:"good first issue"`）算一个词，`-` 开头是取反。
 */

export const MAX_QUERY = 512;
const MAX_TOKENS = 40;

export interface Qualifier {
  readonly key: string;
  readonly value: string;
  readonly negated: boolean;
  /** 用户写的原样，`unsupported` 回报它。 */
  readonly raw: string;
}

export interface ParsedQuery {
  /** 没有限定词形状的词，空格连起来。 */
  readonly text: string;
  readonly qualifiers: readonly Qualifier[];
}

/** 按空白切词，引号里的空白不切；引号本身留在词里。 */
function words(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of input) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (!quoted && /\s/.test(character)) {
      if (current !== "") out.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value.replace(/^"/, "");
}

export function parseQuery(input: string): ParsedQuery {
  const text: string[] = [];
  const qualifiers: Qualifier[] = [];
  for (const word of words(input.slice(0, MAX_QUERY)).slice(0, MAX_TOKENS)) {
    const match = /^(-?)([A-Za-z][A-Za-z-]*):(.+)$/.exec(word);
    const value = match === null ? "" : unquote(match[3] as string);
    if (match === null || value === "" || value.startsWith("//")) {
      text.push(word);
      continue;
    }
    qualifiers.push({
      key: (match[2] as string).toLowerCase(),
      value,
      negated: match[1] === "-",
      raw: word,
    });
  }
  return { text: text.join(" "), qualifiers };
}

/** 一个值要不要加引号。 */
function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', "")}"` : value;
}

export function serialize(parsed: ParsedQuery): string {
  return [
    ...parsed.qualifiers.map(
      (item) => `${item.negated ? "-" : ""}${item.key}:${quote(item.value)}`,
    ),
    ...(parsed.text === "" ? [] : [parsed.text]),
  ].join(" ");
}

export type QueryState = "open" | "closed" | "merged";

function isStateQualifier(item: Qualifier): boolean {
  return (
    !item.negated &&
    (item.key === "is" || item.key === "state") &&
    ["open", "closed", "merged"].includes(item.value.toLowerCase())
  );
}

/** `is:open|closed|merged`（或 `state:`）给的状态；没写 `undefined`，写了多个取第一个。 */
export function stateOf(parsed: ParsedQuery): QueryState | undefined {
  const found = parsed.qualifiers.find(isStateQualifier);
  return found === undefined
    ? undefined
    : (found.value.toLowerCase() as QueryState);
}

export function without(
  parsed: ParsedQuery,
  drop: (item: Qualifier) => boolean,
): { parsed: ParsedQuery; dropped: Qualifier[] } {
  const kept: Qualifier[] = [];
  const dropped: Qualifier[] = [];
  for (const item of parsed.qualifiers)
    (drop(item) ? dropped : kept).push(item);
  return { parsed: { text: parsed.text, qualifiers: kept }, dropped };
}

/** 去掉状态词。 */
export function withoutState(parsed: ParsedQuery): ParsedQuery {
  return without(parsed, isStateQualifier).parsed;
}

/**
 * 能越出这个仓库、或改变 issue / PR 类别的限定词：由 core 自己加（`repo:`、
 * `is:issue|pr`），用户写的丢掉并回报。
 */
const SCOPE_KEYS = new Set([
  "repo",
  "org",
  "user",
  "owner",
  "type",
  "archived",
]);
export function withoutScope(parsed: ParsedQuery): {
  parsed: ParsedQuery;
  dropped: string[];
} {
  const { parsed: rest, dropped } = without(
    parsed,
    (item) =>
      SCOPE_KEYS.has(item.key) ||
      (item.key === "is" &&
        ["issue", "pr", "pull-request"].includes(item.value.toLowerCase())),
  );
  return { parsed: rest, dropped: dropped.map((item) => item.raw) };
}

const SORT_FIELDS = ["updated", "created", "comments"] as const;

/** `sort:updated-desc` 之类：取出（并从词串里去掉）；没有则 `undefined`。 */
export function takeSort(parsed: ParsedQuery): {
  parsed: ParsedQuery;
  sort?: (typeof SORT_FIELDS)[number];
  direction?: "asc" | "desc";
} {
  const { parsed: rest, dropped } = without(
    parsed,
    (item) => !item.negated && item.key === "sort",
  );
  const first = dropped[0];
  if (first === undefined) return { parsed: rest };
  const match = /^([a-z]+)(?:-(asc|desc))?$/.exec(first.value.toLowerCase());
  const field = SORT_FIELDS.find((name) => name === match?.[1]);
  if (field === undefined) return { parsed: rest };
  return {
    parsed: rest,
    sort: field,
    ...(match?.[2] === undefined
      ? {}
      : { direction: match[2] as "asc" | "desc" }),
  };
}

/**
 * 逐个认领限定词：平台代码 `take` 自己懂的，剩下的 {@link rest} 就是 `unsupported`。
 */
export class QueryParts {
  private readonly pending: Qualifier[];
  readonly text: string;

  constructor(parsed: ParsedQuery) {
    this.pending = [...parsed.qualifiers];
    this.text = parsed.text;
  }

  /** 认领所有 `key`（可限取反与否）的限定词。 */
  take(key: string, negated = false): Qualifier[] {
    const taken: Qualifier[] = [];
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const item = this.pending[index] as Qualifier;
      if (item.key === key && item.negated === negated) {
        taken.unshift(item);
        this.pending.splice(index, 1);
      }
    }
    return taken;
  }

  /** 认领 `is:<value>` 形的限定词（不取反）。 */
  takeIs(value: string): boolean {
    const index = this.pending.findIndex(
      (item) =>
        item.key === "is" &&
        !item.negated &&
        item.value.toLowerCase() === value,
    );
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  /** 没人认领的限定词，用户写的原样。 */
  rest(): string[] {
    return this.pending.map((item) => item.raw);
  }
}

/** 排序键：先看 `sort` 参数，没给再看词串里的 `sort:`；都没有按更新时间倒序。 */
export function effectiveSort(
  parsed: ParsedQuery,
  sort: "updated" | "created" | "comments" | undefined,
  direction: "asc" | "desc" | undefined,
): {
  parsed: ParsedQuery;
  sort: "updated" | "created" | "comments";
  direction: "asc" | "desc";
} {
  const taken = takeSort(parsed);
  return {
    parsed: taken.parsed,
    sort: sort ?? taken.sort ?? "updated",
    direction: direction ?? taken.direction ?? "desc",
  };
}
