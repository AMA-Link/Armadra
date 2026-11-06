import type { DatabaseSync } from "node:sqlite";
import { stripControl } from "../collab/refusals";
import { DomainError, badRequest, uuidV7 } from "../workspaces/support";
import type { RulesRead } from "./rules";
import { type ThreadKind, threadsOf } from "./task-runs";
import { POLL_RETENTION_MS } from "./threads";

/**
 * 协调者的来源与候选的账（契约 §104.1–§104.2，#830，R4 第二阶段）。
 *
 *   * **来源**（`router_sources`）：一个协调者节点盯着的一个仓库。只有人能配
 *     （分派抽屉），没有任何 `canvas` 动词能改它的模式与允许名单。
 *   * **候选**（`router_intake`）：来源仓库里一个没人认领的线程的一次「要不要接」。
 *     id 确定，`INSERT OR IGNORE`，重放与重启都不出第二条。不存正文。
 *   * **认领**：有工作项的 `threads` 含这个线程，且那一项还在进行或结束不到 14 天。
 *
 * 轮询在 `intake-watch.ts`，动词在 `collab/control/intake.ts`。
 */

export type SourceMode = "observe" | "auto";
export const SOURCE_MODES: readonly SourceMode[] = ["observe", "auto"];
export const THREAD_KINDS: readonly ThreadKind[] = ["issue", "pull"];

/** 一个协调者最多这么多个来源。 */
export const MAX_SOURCES = 10;
/** 允许名单上限。 */
export const MAX_ALLOW = 50;
/** 判定理由上限（字）。 */
export const MAX_REASON_CHARS = 100;
/** 同一线程最多出这么多条候选（新线程一次 + 重新提起）。 */
export const MAX_RAISES = 3;
/** 没接单的候选留多久（毫秒）。 */
export const CANDIDATE_RETENTION_MS = 90 * 24 * 3_600_000;
/** 统计窗口：最近这么多条判定。 */
export const STATS_WINDOW = 20;

export interface IntakeSource {
  readonly id: string;
  readonly coordinatorNodeId: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly kinds: readonly ThreadKind[];
  readonly mode: SourceMode;
  /** 小写登录名。 */
  readonly allow: readonly string[];
  /** 人确认过的规则哈希；空串是没确认过。 */
  readonly rulesHash: string;
  readonly enabled: boolean;
  readonly cursorAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IntakeRequest {
  readonly by: string;
  readonly via: "thread" | "comment";
  readonly commentId?: string;
  readonly at: number;
}

export type Verdict = "accept" | "skip";
export type Review = "agree" | "disagree";

export interface IntakeCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly coordinatorNodeId: string;
  readonly workspaceId: string;
  readonly kind: ThreadKind;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly url: string;
  readonly request: IntakeRequest;
  readonly authorized: boolean;
  readonly sourceAt: number;
  readonly seenAt: number;
  readonly verdict: Verdict | null;
  readonly verdictReason: string | null;
  readonly verdictAt: number | null;
  readonly rulesHash: string | null;
  readonly modeAtVerdict: SourceMode | null;
  readonly review: Review | null;
  readonly reviewedAt: number | null;
  readonly itemId: string | null;
  readonly dispatchedAt: number | null;
  readonly outcome: string | null;
}

interface SourceRow {
  id: string;
  coordinator_node_id: string;
  workspace_id: string;
  repo: string;
  kinds: string;
  mode: string;
  allow_json: string;
  rules_hash: string;
  enabled: number;
  cursor_at: number;
  created_at: number;
  updated_at: number;
}

interface CandidateRow {
  id: string;
  source_id: string;
  coordinator_node_id: string;
  workspace_id: string;
  kind: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  url: string;
  request_json: string;
  authorized: number;
  source_at: number;
  seen_at: number;
  verdict: string | null;
  verdict_reason: string | null;
  verdict_at: number | null;
  rules_hash: string | null;
  mode_at_verdict: string | null;
  review: string | null;
  reviewed_at: number | null;
  item_id: string | null;
  dispatched_at: number | null;
  outcome: string | null;
}

function jsonArray(text: string): unknown[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function sourceOf(row: SourceRow): IntakeSource {
  return {
    id: row.id,
    coordinatorNodeId: row.coordinator_node_id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    kinds: jsonArray(row.kinds).filter((kind): kind is ThreadKind =>
      THREAD_KINDS.includes(kind as ThreadKind),
    ),
    mode: row.mode === "auto" ? "auto" : "observe",
    allow: jsonArray(row.allow_json).filter(
      (login): login is string => typeof login === "string",
    ),
    rulesHash: row.rules_hash,
    enabled: row.enabled === 1,
    cursorAt: Number(row.cursor_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function requestOf(text: string): IntakeRequest {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return {
      by: typeof value.by === "string" ? value.by : "",
      via: value.via === "comment" ? "comment" : "thread",
      ...(typeof value.commentId === "string"
        ? { commentId: value.commentId }
        : {}),
      at: typeof value.at === "number" ? value.at : 0,
    };
  } catch {
    return { by: "", via: "thread", at: 0 };
  }
}

function candidateOf(row: CandidateRow): IntakeCandidate {
  return {
    id: row.id,
    sourceId: row.source_id,
    coordinatorNodeId: row.coordinator_node_id,
    workspaceId: row.workspace_id,
    kind: row.kind === "issue" ? "issue" : "pull",
    repo: row.repo,
    number: Number(row.number),
    title: row.title,
    author: row.author,
    url: row.url,
    request: requestOf(row.request_json),
    authorized: row.authorized === 1,
    sourceAt: Number(row.source_at),
    seenAt: Number(row.seen_at),
    verdict:
      row.verdict === "accept" || row.verdict === "skip" ? row.verdict : null,
    verdictReason: row.verdict_reason,
    verdictAt: row.verdict_at === null ? null : Number(row.verdict_at),
    rulesHash: row.rules_hash,
    modeAtVerdict:
      row.mode_at_verdict === "auto" || row.mode_at_verdict === "observe"
        ? row.mode_at_verdict
        : null,
    review:
      row.review === "agree" || row.review === "disagree" ? row.review : null,
    reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
    itemId: row.item_id,
    dispatchedAt: row.dispatched_at === null ? null : Number(row.dispatched_at),
    outcome: row.outcome,
  };
}

// ── 来源 ────────────────────────────────────────────────────────────────

/** 允许名单：去空白、小写、去重；每个 1–100 字、不带空白。 */
export function normalizeAllow(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") throw badRequest("allow 只收字符串");
    const login = value.trim().toLowerCase();
    if (login === "") continue;
    if (login.length > 100 || /\s/.test(login)) {
      throw badRequest(`允许名单里的「${login.slice(0, 40)}」不是登录名`);
    }
    if (!out.includes(login)) out.push(login);
  }
  if (out.length > MAX_ALLOW) {
    throw badRequest(`允许名单最多 ${MAX_ALLOW} 个`);
  }
  return out;
}

export function normalizeKinds(list: readonly unknown[]): ThreadKind[] {
  const out = THREAD_KINDS.filter((kind) => list.includes(kind));
  if (out.length === 0 || out.length !== new Set(list).size) {
    throw badRequest("kinds 只能是 issue、pull 或两者");
  }
  return out;
}

/** 登录名在不在允许名单里（大小写不敏感）。 */
export function isAllowed(
  source: Pick<IntakeSource, "allow">,
  login: string | null | undefined,
): boolean {
  if (login === null || login === undefined || login === "") return false;
  return source.allow.includes(login.toLowerCase());
}

const SELECT_SOURCE =
  "SELECT id, coordinator_node_id, workspace_id, repo, kinds, mode, allow_json, rules_hash, enabled, " +
  "cursor_at, created_at, updated_at FROM router_sources";

export function getSource(
  database: DatabaseSync,
  id: string,
): IntakeSource | undefined {
  const row = database.prepare(`${SELECT_SOURCE} WHERE id = ?`).get(id) as
    | SourceRow
    | undefined;
  return row === undefined ? undefined : sourceOf(row);
}

/** 一个协调者名下的来源，建得早的在前。 */
export function sourcesOf(
  database: DatabaseSync,
  coordinatorNodeId: string,
): IntakeSource[] {
  return (
    database
      .prepare(
        `${SELECT_SOURCE} WHERE coordinator_node_id = ? ORDER BY created_at, id`,
      )
      .all(coordinatorNodeId) as unknown as SourceRow[]
  ).map(sourceOf);
}

/** 一块画板上所有协调者的来源。 */
export function sourcesForBoard(
  database: DatabaseSync,
  boardId: string,
): IntakeSource[] {
  return (
    database
      .prepare(
        `${SELECT_SOURCE} WHERE coordinator_node_id IN (SELECT id FROM nodes WHERE board_id = ?) ` +
          "ORDER BY created_at, id",
      )
      .all(boardId) as unknown as SourceRow[]
  ).map(sourceOf);
}

/** 轮询要看的来源：启用的，游标最旧的在前。 */
export function enabledSources(database: DatabaseSync): IntakeSource[] {
  return (
    database
      .prepare(`${SELECT_SOURCE} WHERE enabled = 1 ORDER BY cursor_at, id`)
      .all() as unknown as SourceRow[]
  ).map(sourceOf);
}

export interface SourceInput {
  readonly id?: string | undefined;
  readonly coordinatorNodeId: string;
  readonly workspaceId: string;
  /** 已经由 forge 认过并规范化的 `<主机>/<owner>/<名字>`。 */
  readonly repo: string;
  readonly kinds: readonly unknown[];
  readonly mode: unknown;
  readonly allow: readonly unknown[];
  readonly enabled: boolean;
  /** 把此刻规则文件的哈希记成「人确认过的」。 */
  readonly confirmRules?: boolean | undefined;
}

/**
 * 建或改一个来源（只有人经分派抽屉调用）。切到 `auto` 的前置：允许名单非空；
 * 工作区不在远端；规则已确认且等于此刻文件的哈希。不满足答 `400`，`message`
 * 写明缺什么。
 */
export function saveSource(
  database: DatabaseSync,
  input: SourceInput,
  rules: RulesRead,
  nowMs: number,
): IntakeSource {
  if (input.mode !== "observe" && input.mode !== "auto") {
    throw badRequest("mode 只能是 observe 或 auto");
  }
  const mode: SourceMode = input.mode;
  const kinds = normalizeKinds(input.kinds);
  const allow = normalizeAllow(input.allow);
  const existing =
    input.id === undefined ? undefined : getSource(database, input.id);
  if (input.id !== undefined) {
    if (
      existing === undefined ||
      existing.coordinatorNodeId !== input.coordinatorNodeId
    ) {
      throw new DomainError(404, "source_not_found", "来源不存在");
    }
  }
  let rulesHash = existing?.rulesHash ?? "";
  if (input.confirmRules === true) {
    if (rules.remote) {
      throw badRequest("工作区在远端主机上，本机读不到规则文件，不能确认");
    }
    if (!rules.present) {
      throw badRequest("没有规则文件（.armadra/router/rules.md），不能确认");
    }
    rulesHash = rules.hash;
  }
  if (mode === "auto") {
    if (rules.remote) {
      throw badRequest("工作区在远端主机上，本机读不到规则文件，只能 observe");
    }
    if (allow.length === 0) throw badRequest("切到 auto 需要允许名单");
    if (rulesHash === "") throw badRequest("切到 auto 需要先确认规则文件");
    if (rulesHash !== rules.hash) {
      throw badRequest("规则文件在确认之后改过，需要重新确认");
    }
  }
  if (existing === undefined) {
    const count = database
      .prepare(
        "SELECT COUNT(*) AS total FROM router_sources WHERE coordinator_node_id = ?",
      )
      .get(input.coordinatorNodeId) as { total: number };
    if (Number(count.total) >= MAX_SOURCES) {
      throw new DomainError(
        409,
        "sources_full",
        `一个协调者最多 ${MAX_SOURCES} 个来源`,
      );
    }
  }
  const duplicate = database
    .prepare(
      "SELECT id FROM router_sources WHERE coordinator_node_id = ? AND repo = ? AND id <> ?",
    )
    .get(input.coordinatorNodeId, input.repo, existing?.id ?? "") as
    | { id: string }
    | undefined;
  if (duplicate !== undefined) {
    throw new DomainError(409, "conflict", "这个协调者已经有这个仓库的来源");
  }
  if (existing === undefined) {
    const id = uuidV7(nowMs);
    database
      .prepare(
        "INSERT INTO router_sources (id, coordinator_node_id, workspace_id, repo, kinds, mode, allow_json, " +
          "rules_hash, enabled, cursor_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.coordinatorNodeId,
        input.workspaceId,
        input.repo,
        JSON.stringify(kinds),
        mode,
        JSON.stringify(allow),
        rulesHash,
        input.enabled ? 1 : 0,
        // 不回灌：建来源之前的线程不出候选。
        nowMs,
        nowMs,
        nowMs,
      );
    return getSource(database, id) as IntakeSource;
  }
  // 换仓库等于换了一条游标：从此刻起看，不回灌。
  const cursorAt = existing.repo === input.repo ? existing.cursorAt : nowMs;
  database
    .prepare(
      "UPDATE router_sources SET repo = ?, kinds = ?, mode = ?, allow_json = ?, rules_hash = ?, enabled = ?, " +
        "cursor_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      input.repo,
      JSON.stringify(kinds),
      mode,
      JSON.stringify(allow),
      rulesHash,
      input.enabled ? 1 : 0,
      cursorAt,
      nowMs,
      existing.id,
    );
  return getSource(database, existing.id) as IntakeSource;
}

export function deleteSource(database: DatabaseSync, id: string): boolean {
  const changes = database
    .prepare("DELETE FROM router_sources WHERE id = ?")
    .run(id);
  return Number(changes.changes) > 0;
}

/** 推列表游标（只往前推）。 */
export function advanceCursor(
  database: DatabaseSync,
  id: string,
  cursorAt: number,
): void {
  database
    .prepare(
      "UPDATE router_sources SET cursor_at = MAX(cursor_at, ?) WHERE id = ?",
    )
    .run(cursorAt, id);
}

export interface SourceStats {
  readonly decided: number;
  readonly accepted: number;
  readonly agreed: number;
  readonly disagreed: number;
  readonly window: number;
}

/** 最近 {@link STATS_WINDOW} 条判定里的数目（契约 §104.7）。 */
export function sourceStats(
  database: DatabaseSync,
  sourceId: string,
): SourceStats {
  const rows = database
    .prepare(
      "SELECT verdict, review FROM router_intake WHERE source_id = ? AND verdict IS NOT NULL " +
        "ORDER BY verdict_at DESC, id DESC LIMIT ?",
    )
    .all(sourceId, STATS_WINDOW) as {
    verdict: string;
    review: string | null;
  }[];
  return {
    decided: rows.length,
    accepted: rows.filter((row) => row.verdict === "accept").length,
    agreed: rows.filter((row) => row.review === "agree").length,
    disagreed: rows.filter((row) => row.review === "disagree").length,
    window: STATS_WINDOW,
  };
}

// ── 候选 ────────────────────────────────────────────────────────────────

/**
 * 候选 id：`intake:<仓库>#<编号>:<issue|pull>:<版本>`。新线程的版本是创建时刻的
 * 36 进制，重新提起的是 `c<评论 id>`。
 */
export function candidateId(
  kind: ThreadKind,
  repo: string,
  number: number,
  version: string,
): string {
  return `intake:${repo}#${number}:${kind}:${version}`;
}

/** 新线程的版本号。 */
export function threadVersion(createdAtMs: number): string {
  return Math.max(0, Math.trunc(createdAtMs)).toString(36);
}

/** 重新提起的版本号：评论 id 已经带着 `c` 前缀时不再加。 */
export function commentVersion(commentId: string): string {
  return commentId.startsWith("c") ? commentId : `c${commentId}`;
}

export interface NewCandidate {
  readonly source: IntakeSource;
  readonly kind: ThreadKind;
  readonly number: number;
  readonly version: string;
  readonly title: string;
  readonly author: string | null;
  readonly url: string;
  readonly request: IntakeRequest;
  readonly sourceAt: number;
}

/** 一行标题：折掉换行与空白、去控制字符，截到 `limit` 字。 */
export function foldLine(text: string, limit: number): string {
  const folded = stripControl(text).replace(/\s+/g, " ").trim();
  return [...folded].slice(0, limit).join("");
}

function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url.slice(0, 500) : "";
}

/**
 * 写一条候选。id 确定，已经有就什么也不做；答这次是不是新写的。`authorized`
 * 在这里按此刻的允许名单算。
 */
export function insertCandidate(
  database: DatabaseSync,
  candidate: NewCandidate,
  nowMs: number,
): { readonly inserted: boolean; readonly id: string } {
  const source = candidate.source;
  const id = candidateId(
    candidate.kind,
    source.repo,
    candidate.number,
    candidate.version,
  );
  const request: IntakeRequest = {
    by: foldLine(candidate.request.by, 100),
    via: candidate.request.via,
    ...(candidate.request.commentId === undefined
      ? {}
      : { commentId: candidate.request.commentId }),
    at: candidate.request.at,
  };
  const changes = database
    .prepare(
      "INSERT OR IGNORE INTO router_intake (id, source_id, coordinator_node_id, workspace_id, kind, repo, number, " +
        "title, author, url, request_json, authorized, source_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      source.id,
      source.coordinatorNodeId,
      source.workspaceId,
      candidate.kind,
      source.repo,
      candidate.number,
      foldLine(candidate.title, 80),
      candidate.author === null ? null : foldLine(candidate.author, 100),
      safeUrl(candidate.url),
      JSON.stringify(request),
      isAllowed(source, request.by) ? 1 : 0,
      candidate.sourceAt,
      nowMs,
    );
  return { inserted: Number(changes.changes) > 0, id };
}

const SELECT_CANDIDATE =
  "SELECT id, source_id, coordinator_node_id, workspace_id, kind, repo, number, title, author, url, request_json, " +
  "authorized, source_at, seen_at, verdict, verdict_reason, verdict_at, rules_hash, mode_at_verdict, review, " +
  "reviewed_at, item_id, dispatched_at, outcome FROM router_intake";

export function getCandidate(
  database: DatabaseSync,
  id: string,
): IntakeCandidate | undefined {
  const row = database.prepare(`${SELECT_CANDIDATE} WHERE id = ?`).get(id) as
    | CandidateRow
    | undefined;
  return row === undefined ? undefined : candidateOf(row);
}

/** 同一线程在这个来源里的候选，最新的在前。 */
export function threadCandidates(
  database: DatabaseSync,
  sourceId: string,
  kind: ThreadKind,
  number: number,
): IntakeCandidate[] {
  return (
    database
      .prepare(
        `${SELECT_CANDIDATE} WHERE source_id = ? AND kind = ? AND number = ? ORDER BY seen_at DESC, id DESC`,
      )
      .all(sourceId, kind, number) as unknown as CandidateRow[]
  ).map(candidateOf);
}

export interface CandidateQuery {
  /** 只看这些协调者的（页面按画板给，动词按调用者给）。 */
  readonly coordinatorNodeIds: readonly string[];
  /** `true` 只要判定过的，`false` 只要没判定的，缺省都要。 */
  readonly decided?: boolean | undefined;
  readonly limit: number;
  readonly offset?: number | undefined;
  /** 没判定的按最早在前（协调者处理的顺序），判定过的按最近在前。 */
  readonly order?: "oldest" | "newest" | undefined;
}

export function listCandidates(
  database: DatabaseSync,
  query: CandidateQuery,
): { readonly candidates: IntakeCandidate[]; readonly total: number } {
  if (query.coordinatorNodeIds.length === 0) {
    return { candidates: [], total: 0 };
  }
  const marks = query.coordinatorNodeIds.map(() => "?").join(", ");
  const where = [`coordinator_node_id IN (${marks})`];
  if (query.decided === true) where.push("verdict IS NOT NULL");
  if (query.decided === false) where.push("verdict IS NULL");
  const clause = where.join(" AND ");
  const order =
    query.order === "oldest" ? "seen_at ASC, id ASC" : "seen_at DESC, id DESC";
  const rows = database
    .prepare(
      `${SELECT_CANDIDATE} WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(
      ...query.coordinatorNodeIds,
      query.limit,
      query.offset ?? 0,
    ) as unknown as CandidateRow[];
  const total = database
    .prepare(`SELECT COUNT(*) AS total FROM router_intake WHERE ${clause}`)
    .get(...query.coordinatorNodeIds) as { total: number };
  return { candidates: rows.map(candidateOf), total: Number(total.total) };
}

/** 判定理由：去控制字符、折叠空白，1–{@link MAX_REASON_CHARS} 字。 */
export function normalizeReason(reason: unknown): string {
  if (typeof reason !== "string") throw badRequest("--reason 必填");
  const folded = foldLine(reason, MAX_REASON_CHARS + 1);
  if (folded === "") throw badRequest("--reason 必填");
  if ([...folded].length > MAX_REASON_CHARS) {
    throw badRequest(`--reason 最多 ${MAX_REASON_CHARS} 字`);
  }
  return folded;
}

/**
 * 记判定：一次定死，已经判定过答 `409 already_decided`。`rulesHash` 是判定时
 * 规则文件的哈希（缺失写空串），`mode` 是那时来源的模式。
 */
export function recordVerdict(
  database: DatabaseSync,
  id: string,
  verdict: {
    readonly verdict: Verdict;
    readonly reason: string;
    readonly rulesHash: string;
    readonly mode: SourceMode;
  },
  nowMs: number,
): IntakeCandidate {
  const changes = database
    .prepare(
      "UPDATE router_intake SET verdict = ?, verdict_reason = ?, verdict_at = ?, rules_hash = ?, mode_at_verdict = ? " +
        "WHERE id = ? AND verdict IS NULL",
    )
    .run(
      verdict.verdict,
      verdict.reason,
      nowMs,
      verdict.rulesHash,
      verdict.mode,
      id,
    );
  if (Number(changes.changes) === 0) {
    if (getCandidate(database, id) === undefined) {
      throw new DomainError(404, "candidate_not_found", "候选不存在");
    }
    throw new DomainError(409, "already_decided", "这条候选已经判定过");
  }
  return getCandidate(database, id) as IntakeCandidate;
}

/** 人的复核：`agree` / `disagree`，`null` 撤回。只影响这一行与统计。 */
export function reviewCandidate(
  database: DatabaseSync,
  id: string,
  review: Review | null,
  nowMs: number,
): IntakeCandidate {
  const candidate = getCandidate(database, id);
  if (candidate === undefined) {
    throw new DomainError(404, "candidate_not_found", "候选不存在");
  }
  if (candidate.verdict === null) {
    throw new DomainError(409, "conflict", "还没判定的候选不能复核");
  }
  database
    .prepare(
      "UPDATE router_intake SET review = ?, reviewed_at = ? WHERE id = ?",
    )
    .run(review, review === null ? null : nowMs, id);
  return getCandidate(database, id) as IntakeCandidate;
}

/** 接单成功：记工作项与时刻。 */
export function markDispatched(
  database: DatabaseSync,
  id: string,
  itemId: string,
  nowMs: number,
): void {
  database
    .prepare(
      "UPDATE router_intake SET item_id = ?, dispatched_at = ?, outcome = 'dispatched' WHERE id = ? AND item_id IS NULL",
    )
    .run(itemId, nowMs, id);
}

/** 接单被拒：记最近一次的原因码。已经接了单的不改。 */
export function markRefused(
  database: DatabaseSync,
  id: string,
  code: string,
): void {
  database
    .prepare(
      "UPDATE router_intake SET outcome = ? WHERE id = ? AND item_id IS NULL",
    )
    .run(`refused:${code}`.slice(0, 80), id);
}

/** 这个来源最近一小时出了几条候选（按 `seen_at`）。 */
export function candidatesSince(
  database: DatabaseSync,
  sourceId: string,
  sinceMs: number,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM router_intake WHERE source_id = ? AND seen_at >= ?",
    )
    .get(sourceId, sinceMs) as { total: number };
  return Number(row.total);
}

/** 这个来源从 `sinceMs` 起 auto 接了几单（按 `dispatched_at`）。 */
export function dispatchesSince(
  database: DatabaseSync,
  sourceId: string,
  sinceMs: number,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM router_intake WHERE source_id = ? AND dispatched_at >= ?",
    )
    .get(sourceId, sinceMs) as { total: number };
  return Number(row.total);
}

/** 这个协调者经接单起的、还在进行中的工作项数。 */
export function runningIntakeItems(
  database: DatabaseSync,
  coordinatorNodeId: string,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM router_intake AS i JOIN workflow_task_runs AS r ON r.task_id = i.item_id " +
        "WHERE i.coordinator_node_id = ? AND r.status = 'running'",
    )
    .get(coordinatorNodeId) as { total: number };
  return Number(row.total);
}

/** 清理：没接单、读到超过 90 天的候选。答删了几条。 */
export function pruneCandidates(database: DatabaseSync, nowMs: number): number {
  const changes = database
    .prepare("DELETE FROM router_intake WHERE item_id IS NULL AND seen_at < ?")
    .run(nowMs - CANDIDATE_RETENTION_MS);
  return Number(changes.changes);
}

// ── 认领 ────────────────────────────────────────────────────────────────

/**
 * 认领判定（契约 §104.2）：有工作项的 `threads` 含这个线程（种类 + 仓库 + 编号），
 * 且那一项还在进行或结束不到 14 天，答它的 id；没有答 `null`。
 */
export function claimedBy(
  database: DatabaseSync,
  kind: ThreadKind,
  repo: string,
  number: number,
  nowMs: number,
): string | null {
  const rows = database
    .prepare(
      "SELECT task_id, threads FROM workflow_task_runs WHERE threads LIKE ? " +
        "AND (status = 'running' OR COALESCE(ended_at, 0) >= ?) ORDER BY started_at DESC",
    )
    .all(`%"number":${number}%`, nowMs - POLL_RETENTION_MS) as {
    task_id: string;
    threads: string;
  }[];
  for (const row of rows) {
    if (
      threadsOf(row.threads).some(
        (thread) =>
          thread.kind === kind &&
          thread.repo === repo &&
          thread.number === number,
      )
    ) {
      return row.task_id;
    }
  }
  return null;
}
