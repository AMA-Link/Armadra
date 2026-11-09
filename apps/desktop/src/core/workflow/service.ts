import type { DatabaseSync } from "node:sqlite";
import type { WorkItemStage } from "@armadra/shared";
import { validAgentId } from "../agent/registry";
import type { CollabContext } from "../collab/service";
import { DomainError, uuidV7 } from "../workspaces/support";
import { DeliveryRefused, deliverPrompt } from "./dispatch";
import { parseDraft } from "./draft";
import type { WorkflowEngine } from "./engine";
import {
  type DraftRow,
  type RunRow,
  type StepRow,
  type TemplateRow,
  deleteTemplate,
  draftById,
  insertDraft,
  insertTemplate,
  listDrafts,
  listRuns,
  listTemplates,
  runById,
  settleDraft,
  stepsOf,
  templateById,
  updateTemplate,
} from "./store";
import {
  type TaskRun,
  publishTask,
  reopenTask,
  taskPrompt,
  taskRun,
  taskRunsForBoard,
} from "./task-runs";
import {
  DRAFT_STATUSES,
  type DraftStatus,
  type GateDecision,
  type WorkflowDraft,
} from "./types";
import {
  type RouterReply,
  latestReplies,
  markRepliesRead,
} from "../collab/router-replies";
import { stageOf } from "./work-items";
import { forgeService } from "../forge/registry";
import type { ForgeService } from "../forge/service";
import {
  type IntakeCandidate,
  type IntakeSource,
  type Review,
  deleteSource,
  getCandidate,
  getSource,
  listCandidates,
  reviewCandidate,
  saveSource,
  sourceStats,
  sourcesForBoard,
} from "./intake";
import { readRules } from "./rules";
import { publishIntake } from "../collab/intake-fanout";

/**
 * 工作流的服务层：草案存取与确认、模板 CRUD、运行的起停与关卡（契约 §15.2–
 * §15.3）。HTTP 面（`routes.ts`）与控制动词（`collab/control/workflow.ts`）都
 * 经过它，规矩只写一处。
 */

export interface WorkflowServiceOptions {
  readonly database: DatabaseSync;
  readonly engine: WorkflowEngine;
  readonly collab: () => CollabContext | undefined;
  readonly clock?: () => number;
  /** 托管平台服务；缺省取装配好的那个（契约 §104.7 认仓库用）。 */
  readonly forge?: () => ForgeService | undefined;
}

const RULES = { validAgentId };

/** 一个来源加上规则文件此刻的状态与最近 20 条判定的统计。 */
export interface SourceView {
  readonly source: IntakeSource;
  readonly rulesCurrentHash: string;
  readonly rulesPresent: boolean;
  readonly stats: ReturnType<typeof sourceStats>;
}

export class WorkflowService {
  readonly database: DatabaseSync;
  readonly engine: WorkflowEngine;
  private readonly clock: () => number;

  constructor(private readonly options: WorkflowServiceOptions) {
    this.database = options.database;
    this.engine = options.engine;
    this.clock = options.clock ?? (() => Date.now());
  }

  /* --------------------------------- 草案 --------------------------------- */

  /** `workflow-propose`：校验、落库、告诉页面出一张草案卡。 */
  propose(
    origin: {
      readonly workspaceId: string;
      readonly boardId: string;
      readonly nodeId: string | null;
    },
    raw: unknown,
  ): DraftRow {
    const draft = parseDraft(raw, RULES);
    const row = insertDraft(this.database, {
      id: uuidV7(),
      workspaceId: origin.workspaceId,
      boardId: origin.boardId,
      proposerNodeId: origin.nodeId,
      draft,
      createdAt: this.clock(),
    });
    this.publishDraft(row);
    return row;
  }

  drafts(filter: {
    readonly boardId?: string | undefined;
    readonly status?: string | undefined;
  }): DraftRow[] {
    if (
      filter.status !== undefined &&
      !(DRAFT_STATUSES as readonly string[]).includes(filter.status)
    ) {
      throw new DomainError(
        400,
        "bad_request",
        `status 只能是 ${DRAFT_STATUSES.join(" / ")}。`,
      );
    }
    return listDrafts(this.database, {
      boardId: filter.boardId,
      status: filter.status as DraftStatus | undefined,
    });
  }

  draft(id: string): DraftRow {
    const row = draftById(this.database, id);
    if (row === undefined) throw notFound("没有这份草案。");
    return row;
  }

  /**
   * 确认：草案（人可能改过，`draft` 给了就用它）存成模板，草案记 `confirmed`。
   * 两步在一个事务里：不会有一份确认了却没有模板的草案。
   */
  confirm(
    id: string,
    edit: { readonly name?: unknown; readonly draft?: unknown },
  ): { draft: DraftRow; template: TemplateRow } {
    const row = this.draft(id);
    if (row.status !== "pending") throw draftNotPending();
    const body =
      edit.draft === undefined ? row.draft : parseDraft(edit.draft, RULES);
    const name = templateName(edit.name, body);
    const now = this.clock();
    const templateId = uuidV7();
    let template: TemplateRow;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!settleDraft(this.database, id, "confirmed", templateId, now)) {
        throw draftNotPending();
      }
      template = insertTemplate(this.database, {
        id: templateId,
        name,
        template: body,
        createdFromDraft: id,
        createdAt: now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const settled = this.draft(id);
    this.publishDraft(settled);
    return { draft: settled, template };
  }

  discard(id: string): DraftRow {
    const row = this.draft(id);
    if (!settleDraft(this.database, row.id, "discarded", null, this.clock())) {
      throw draftNotPending();
    }
    const settled = this.draft(id);
    this.publishDraft(settled);
    return settled;
  }

  /* --------------------------------- 模板 --------------------------------- */

  templates(): TemplateRow[] {
    return listTemplates(this.database);
  }

  template(id: string): TemplateRow {
    const row = templateById(this.database, id);
    if (row === undefined) throw notFound("没有这个模板。");
    return row;
  }

  createTemplate(body: {
    readonly name?: unknown;
    readonly template?: unknown;
  }): TemplateRow {
    const template = parseDraft(body.template, RULES);
    return insertTemplate(this.database, {
      id: uuidV7(),
      name: templateName(body.name, template),
      template,
      createdFromDraft: null,
      createdAt: this.clock(),
    });
  }

  /** 改模板：`template.version` 必须比库里的大（只增）。 */
  updateTemplate(
    id: string,
    body: { readonly name?: unknown; readonly template?: unknown },
  ): TemplateRow {
    const current = this.template(id);
    const template = parseDraft(body.template, RULES);
    const name =
      body.name === undefined
        ? current.name
        : templateName(body.name, template);
    if (
      template.version <= current.version ||
      !updateTemplate(this.database, id, name, template, this.clock())
    ) {
      throw new DomainError(
        409,
        "template_version_stale",
        `模板的 version 只增：库里是 ${current.version}，这次要大于它。`,
      );
    }
    return this.template(id);
  }

  deleteTemplate(id: string): void {
    if (!deleteTemplate(this.database, id)) throw notFound("没有这个模板。");
  }

  /* --------------------------------- 运行 --------------------------------- */

  async startRun(body: {
    readonly templateId?: unknown;
    readonly params?: unknown;
    readonly boardId?: unknown;
  }): Promise<RunRow> {
    if (typeof body.templateId !== "string" || body.templateId === "") {
      throw new DomainError(400, "bad_request", "templateId 不能缺。");
    }
    if (body.boardId !== undefined && typeof body.boardId !== "string") {
      throw new DomainError(400, "bad_request", "boardId 必须是字符串。");
    }
    const template = this.template(body.templateId);
    return this.engine.startRun({
      template,
      params: body.params,
      boardId: body.boardId as string | undefined,
    });
  }

  runs(filter: {
    readonly templateId?: string | undefined;
    readonly boardId?: string | undefined;
    readonly limit?: number | undefined;
  }): RunRow[] {
    return listRuns(this.database, filter);
  }

  run(id: string): RunRow {
    const row = runById(this.database, id);
    if (row === undefined) throw notFound("没有这次运行。");
    return row;
  }

  steps(runId: string): StepRow[] {
    return stepsOf(this.database, runId);
  }

  cancel(id: string): Promise<RunRow> {
    return this.engine.cancel(id);
  }

  answerGate(
    runId: string,
    stepId: string,
    body: { readonly decision?: unknown; readonly note?: unknown },
  ): Promise<RunRow> {
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new DomainError(
        400,
        "bad_request",
        "decision 只能是 approve / reject。",
      );
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      (typeof body.note !== "string" || [...body.note].length > 2_000)
    ) {
      throw new DomainError(
        400,
        "bad_request",
        "note 是最多 2000 字的字符串。",
      );
    }
    return this.engine.answerGate(
      runId,
      stepId,
      body.decision as GateDecision,
      (body.note as string | null | undefined) ?? undefined,
    );
  }

  /* ------------------------------ 协调者任务 ------------------------------ */

  /** 一行此刻的阶段（契约 §90.2）：由事实推出。 */
  stageOf(run: TaskRun): WorkItemStage {
    return stageOf(this.database, run, Math.floor(this.clock() / 1000));
  }

  /** 一个协调者名下每个工作项的最新一条回复（契约 §101.2）。 */
  replies(coordinatorNodeId: string): Map<string, RouterReply> {
    return latestReplies(this.database, coordinatorNodeId);
  }

  /**
   * 人打开分派抽屉：这块画板上协调者的回复都标为已读（契约 §101.2）。答标了几条。
   */
  readReplies(boardId: unknown): number {
    if (typeof boardId !== "string" || boardId === "") {
      throw new DomainError(400, "bad_request", "boardId 不能缺。");
    }
    const coordinators = this.database
      .prepare(
        "SELECT DISTINCT coordinator_node_id AS id FROM workflow_task_runs WHERE coordinator_node_id IN " +
          "(SELECT id FROM nodes WHERE board_id = ?)",
      )
      .all(boardId) as { id: string }[];
    return markRepliesRead(
      this.database,
      coordinators.map((row) => row.id),
      this.clock(),
    );
  }

  /** 一块画板上协调者分派出去的任务（契约 §15.7）。 */
  tasks(boardId: unknown): TaskRun[] {
    if (typeof boardId !== "string" || boardId === "") {
      throw new DomainError(400, "bad_request", "boardId 不能缺。");
    }
    return taskRunsForBoard(this.database, boardId);
  }

  /**
   * 分派抽屉的「重试」（契约 §15.7）：把起任务时的那条正文从协调者再投给同一
   * 个成员节点（投递队列，门链与 `canvas send` 相同——不替人回答任何提示），
   * 任务行回到 `running`。
   */
  retryTask(taskId: string): TaskRun {
    const run = taskRun(this.database, taskId);
    if (run === undefined) throw notFound("没有这个任务。");
    if (run.status !== "failed" && run.status !== "stopped") {
      throw new DomainError(409, "task_not_failed", "这个任务没有失败。");
    }
    const prompt = taskPrompt(run);
    if (prompt === undefined) {
      throw new DomainError(
        409,
        "task_prompt_missing",
        "这个任务没有记下任务正文。",
      );
    }
    const place = this.database
      .prepare(
        "SELECT b.workspace_id AS workspace_id FROM nodes n JOIN boards b ON b.id = n.board_id " +
          "WHERE n.id = ? AND n.board_id = (SELECT board_id FROM nodes WHERE id = ?)",
      )
      .get(run.nodeId, run.coordinatorNodeId) as
      { workspace_id?: unknown } | undefined;
    if (typeof place?.workspace_id !== "string") {
      throw new DomainError(
        409,
        "task_node_missing",
        "成员节点已经不在画布上了。",
      );
    }
    const collab = this.options.collab();
    if (collab === undefined) {
      throw new DomainError(501, "unsupported", "协作域还没有装好。");
    }
    try {
      deliverPrompt(collab, {
        workspaceId: place.workspace_id,
        sourceNodeId: run.coordinatorNodeId,
        targetNodeId: run.nodeId,
        body: prompt,
        nowSeconds: Math.floor(this.clock() / 1000),
      });
    } catch (error) {
      if (error instanceof DeliveryRefused) {
        throw new DomainError(409, "queue_full", error.message);
      }
      throw error;
    }
    if (reopenTask(this.database, taskId, this.clock())) {
      publishTask(this.database, collab.publish, taskId);
    }
    return taskRun(this.database, taskId) as TaskRun;
  }

  /* ------------------------- 来源与候选（契约 §104.7） ------------------------- */

  /** 一块画板上协调者节点的标识；画板不存在答 404。 */
  private boardCoordinators(boardId: unknown): string[] {
    if (typeof boardId !== "string" || boardId === "") {
      throw new DomainError(400, "bad_request", "boardId 不能缺。");
    }
    const board = this.database
      .prepare("SELECT id FROM boards WHERE id = ?")
      .get(boardId);
    if (board === undefined) throw notFound("没有这块画板。");
    return (
      this.database
        .prepare("SELECT id FROM nodes WHERE board_id = ?")
        .all(boardId) as { id: string }[]
    ).map((row) => row.id);
  }

  /** 一个来源连同规则文件此刻的状态与统计。 */
  sourceView(source: IntakeSource): SourceView {
    const rules = readRules(this.database, source.workspaceId);
    return {
      source,
      rulesCurrentHash: rules.hash,
      rulesPresent: rules.present,
      stats: sourceStats(this.database, source.id),
    };
  }

  sources(boardId: unknown): SourceView[] {
    this.boardCoordinators(boardId);
    return sourcesForBoard(this.database, boardId as string).map((source) =>
      this.sourceView(source),
    );
  }

  /**
   * 仓库写法：网页地址或 `<主机>/<owner>/<名字>`，交给托管平台域的 `resolve` 认并
   * 规范化。认不出 400，托管平台域没装配 409 `forge_not_wired`。
   */
  private resolveRepo(raw: string, workspaceId: string): string {
    const forge = (this.options.forge ?? forgeService)();
    if (forge === undefined) {
      throw new DomainError(
        409,
        "forge_not_wired",
        "托管平台域没有装配，不能配置来源。",
      );
    }
    const bad = () =>
      new DomainError(
        400,
        "bad_request",
        "repo 要给网页地址或 <主机>/<owner>/<名字>，且在已配置的 GitHub / Gitea / GitLab 上。",
      );
    const text = raw.trim();
    let remote: string;
    if (/^https?:\/\//i.test(text)) {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        throw bad();
      }
      if (url.username !== "" || url.password !== "") throw bad();
      // 线程或页面的地址：截掉 issue / PR / 树等尾巴，只留仓库。
      const segments = url.pathname.split("/").filter((part) => part !== "");
      const tail = segments.findIndex((part) =>
        [
          "issues",
          "pull",
          "pulls",
          "merge_requests",
          "-",
          "tree",
          "blob",
        ].includes(part),
      );
      const project = tail < 0 ? segments : segments.slice(0, tail);
      remote = `${url.protocol}//${url.host}/${project.join("/")}`;
    } else {
      if (/\s/.test(text) || text.includes("://") || text.includes("@")) {
        throw bad();
      }
      remote = `https://${text}`;
    }
    let detection;
    try {
      detection = forge.resolve(remote, workspaceId);
    } catch {
      throw bad();
    }
    if (detection.forge === null) throw bad();
    const repo = detection.repository;
    return `${repo.host}/${repo.owner}/${repo.name}`;
  }

  saveSource(body: Record<string, unknown>): SourceView {
    const text = (value: unknown, name: string): string => {
      if (typeof value !== "string" || value.trim() === "") {
        throw new DomainError(400, "bad_request", `${name} 不能缺。`);
      }
      return value;
    };
    const list = (value: unknown, name: string): unknown[] => {
      if (!Array.isArray(value)) {
        throw new DomainError(400, "bad_request", `${name} 必须是数组。`);
      }
      return value;
    };
    const flag = (value: unknown, name: string): boolean => {
      if (typeof value !== "boolean") {
        throw new DomainError(400, "bad_request", `${name} 必须是布尔值。`);
      }
      return value;
    };
    const coordinatorNodeId = text(body.coordinatorNodeId, "coordinatorNodeId");
    const raw = text(body.repo, "repo");
    const id =
      body.id === undefined || body.id === null
        ? undefined
        : text(body.id, "id");
    const place = this.database
      .prepare(
        "SELECT b.workspace_id AS workspace_id FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
      )
      .get(coordinatorNodeId) as { workspace_id?: unknown } | undefined;
    if (typeof place?.workspace_id !== "string") {
      throw new DomainError(404, "not_found", "协调者节点不在任何画板上。");
    }
    const workspaceId = place.workspace_id;
    const existing =
      id === undefined ? undefined : getSource(this.database, id);
    // 仓库没改就不必再问托管平台域（只切开关、模式或名单时它可以没装配）。
    const repo =
      existing !== undefined && existing.repo === raw.trim()
        ? existing.repo
        : this.resolveRepo(raw, workspaceId);
    const confirm = body.confirmRules;
    const saved = saveSource(
      this.database,
      {
        id,
        coordinatorNodeId,
        workspaceId,
        repo,
        kinds: list(body.kinds, "kinds"),
        mode: body.mode,
        allow: list(body.allow, "allow"),
        enabled: flag(body.enabled, "enabled"),
        confirmRules:
          confirm === undefined ? undefined : flag(confirm, "confirmRules"),
      },
      readRules(this.database, workspaceId),
      this.clock(),
    );
    return this.sourceView(saved);
  }

  deleteSource(id: unknown): boolean {
    if (typeof id !== "string" || id === "") {
      throw new DomainError(400, "bad_request", "id 不能缺。");
    }
    return deleteSource(this.database, id);
  }

  /** 一块画板上协调者的候选，一页。 */
  intake(
    boardId: unknown,
    page: { limit?: unknown; offset?: unknown; decided?: unknown },
  ): { candidates: IntakeCandidate[]; total: number; next: number | null } {
    const coordinatorNodeIds = this.boardCoordinators(boardId);
    const number = (value: unknown, name: string, fallback: number) => {
      if (value === undefined || value === "") return fallback;
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new DomainError(400, "bad_request", `${name} 必须是非负整数。`);
      }
      return parsed;
    };
    const limit = Math.min(Math.max(number(page.limit, "limit", 50), 1), 200);
    const offset = number(page.offset, "offset", 0);
    let decided: boolean | undefined;
    if (page.decided === true || page.decided === "true") decided = true;
    else if (page.decided === false || page.decided === "false")
      decided = false;
    else if (page.decided !== undefined && page.decided !== "") {
      throw new DomainError(
        400,
        "bad_request",
        "decided 只能是 true 或 false。",
      );
    }
    const { candidates, total } = listCandidates(this.database, {
      coordinatorNodeIds,
      decided,
      limit,
      offset,
      // 没判定的按协调者处理的顺序（最早在前），其余最近在前。
      order: decided === false ? "oldest" : "newest",
    });
    const end = offset + candidates.length;
    return { candidates, total, next: end < total ? end : null };
  }

  /** 人的复核；`null` 撤回。 */
  reviewIntake(candidateId: unknown, review: unknown): IntakeCandidate {
    if (typeof candidateId !== "string" || candidateId === "") {
      throw new DomainError(400, "bad_request", "candidateId 不能缺。");
    }
    if (review !== null && review !== "agree" && review !== "disagree") {
      throw new DomainError(
        400,
        "bad_request",
        "review 只能是 agree、disagree 或 null。",
      );
    }
    if (getCandidate(this.database, candidateId) === undefined) {
      throw new DomainError(404, "candidate_not_found", "候选不存在");
    }
    const reviewed = reviewCandidate(
      this.database,
      candidateId,
      review as Review | null,
      this.clock(),
    );
    // 复核也推一帧（契约 §104.4）：别的页面据此重读统计。
    publishIntake(this.database, this.options.collab()?.publish, reviewed);
    return reviewed;
  }

  /* --------------------------------- 发布 --------------------------------- */

  private publishDraft(row: DraftRow): void {
    this.options.collab()?.publish(row.workspaceId, {
      type: "workflow.draft",
      draftId: row.id,
      boardId: row.boardId,
      status: row.status,
    });
  }
}

function templateName(raw: unknown, template: WorkflowDraft): string {
  if (raw === undefined || raw === null) return template.title;
  if (typeof raw !== "string" || raw.trim() === "" || [...raw].length > 160) {
    throw new DomainError(400, "bad_request", "name 是 1–160 个字符。");
  }
  return raw.trim();
}

function notFound(message: string): DomainError {
  return new DomainError(404, "not_found", message);
}

function draftNotPending(): DomainError {
  return new DomainError(
    409,
    "draft_not_pending",
    "这份草案已经确认或丢弃了。",
  );
}

/* ---------------------------------- JSON ---------------------------------- */

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function draftJson(row: DraftRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    boardId: row.boardId,
    proposerNodeId: row.proposerNodeId,
    status: row.status,
    templateId: row.templateId,
    draft: row.draft,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function templateJson(row: TemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdFromDraft: row.createdFromDraft,
    template: row.template,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function stepJson(row: StepRow, run: RunRow): Record<string, unknown> {
  const definition = run.template.steps.find((step) => step.id === row.stepId);
  return {
    stepId: row.stepId,
    kind: row.kind,
    role:
      definition === undefined || definition.kind === "gate"
        ? null
        : definition.role,
    status: row.status,
    nodeId: row.nodeId,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    reason: row.reason,
    outputs: row.outcome?.outputs ?? [],
    decision: row.outcome?.decision ?? null,
    note: row.outcome?.note ?? null,
  };
}

export function runJson(
  row: RunRow,
  steps: readonly StepRow[],
): Record<string, unknown> {
  return {
    id: row.id,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    title: row.template.title,
    workspaceId: row.workspaceId,
    boardId: row.boardId,
    frameId: row.frameId,
    params: row.params,
    status: row.status,
    reason: row.reason,
    roles: row.roles,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    steps: steps.map((step) => stepJson(step, row)),
  };
}
