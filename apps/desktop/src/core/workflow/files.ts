import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_ID_PATTERN as FILE_ID_PATTERN,
  formatWorkflowFile,
  parseWorkflowFile,
  validateWorkflow,
} from "@armadra/agent/workflow";
import { validAgentId } from "../agent/registry";
import { executeOn } from "../remote/execute";
import { DomainError, uuidV7 } from "../workspaces/support";
import type { Workspace } from "../workspaces/table";
import { parseDraft } from "./draft";
import {
  type TemplateRow,
  insertTemplate,
  templateByFileRef,
  updateTemplate,
} from "./store";
import type { WorkflowDraft } from "./types";

/**
 * 项目级工作流文件 `.ama/workflows/<id>.md` 的导入与导出（契约 §121）。
 *
 * 解析、生成、校验都用 ama 的纯函数（`@armadra/agent/workflow`），Armadra 不自写
 * 文件格式。读写走 `remote/execute.ts::executeOn`，与文件面同一条：本机与远端执行
 * 主机上的工作空间都能用，远端绝不回退到控制端磁盘。**只碰当前工作空间的项目级
 * 目录**；ama 的用户级目录 `<configDir>/workflows` 不在这里。
 *
 * 往返不规整 glob、不写回缺省值：导出时去掉草案里补齐的缺省（参数类型 `string`、
 * 连线角色 `peer`、空的 `after`）与空值，所以 ama 示例文件导入再导出，两次
 * `ama.parse` 深相等；不要求字节相同。
 */

export const WORKFLOW_DIR = ".ama/workflows";
const RULES = { validAgentId };
/** 一次列出的文件上限与并发读取数。 */
const MAX_FILES = 200;
const READ_BATCH = 8;

export interface WorkflowFileEntry {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly valid: boolean;
  readonly error: string | null;
  readonly templateId: string | null;
}

export type FileChange = "created" | "updated" | "unchanged";

export function fileRef(workspaceId: string, id: string): string {
  return `${workspaceId}/${id}`;
}

export function workflowFilePath(id: string): string {
  return `${WORKFLOW_DIR}/${id}.md`;
}

/** 文件 id（= 文件名去掉 `.md`）：与 ama 同一条规则，也挡住路径穿越。 */
export function checkFileId(id: unknown): string {
  if (typeof id !== "string" || !FILE_ID_PATTERN.test(id)) {
    throw new DomainError(
      400,
      "bad_request",
      "id 必须以字母开头，最多 32 个字母、数字、下划线或短横线。",
    );
  }
  return id;
}

/* ------------------------------ 本机 / 远端读写 ------------------------------ */

function readable(workspace: Workspace): Workspace {
  if (!workspace.permissions.read) {
    throw new DomainError(403, "forbidden", "This workspace is not readable");
  }
  return workspace;
}

function writable(workspace: Workspace): Workspace {
  if (!workspace.permissions.write) {
    throw new DomainError(
      403,
      "forbidden",
      "This workspace is opened read-only",
    );
  }
  return workspace;
}

function ran<T>(...args: Parameters<typeof executeOn>): Promise<T> {
  return executeOn(...args) as Promise<T>;
}

/** 目录或文件不存在在文件面上是 400 / 404：当作「没有」。 */
function missing(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.status === 400 || error.status === 404)
  );
}

interface ReadBack {
  readonly content: string;
  readonly encoding?: string;
  readonly bom?: boolean;
}

/** 文件原文：带 BOM 的补回去，ama 的 hash 算的是读到的整段文本。 */
async function readText(workspace: Workspace, path: string): Promise<string> {
  const read = await ran<ReadBack>(workspace, "files.read", { path });
  if (read.encoding === "unknown") {
    throw new DomainError(400, "invalid_draft", "文件不是 UTF-8 文本。");
  }
  return `${read.bom === true ? "﻿" : ""}${read.content}`;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function firstIssue(
  issues: readonly { path: string; message: string; severity: string }[],
): string {
  const issue = issues.find((item) => item.severity === "error") ?? issues[0];
  return issue === undefined
    ? "不是合法的工作流文件。"
    : `${issue.path}: ${issue.message}`;
}

/** ama 解析 + Armadra 草案校验；`acp:*` 在这里被拒（ama 认、画布注册表不认）。 */
export function draftOfText(text: string): WorkflowDraft {
  const parsed = parseWorkflowFile(text);
  if (parsed.workflow === undefined) {
    throw new DomainError(400, "invalid_draft", firstIssue(parsed.issues));
  }
  return withoutSource(parseDraft(parsed.workflow, RULES));
}

/**
 * `source` 是本机画布上的 boardId / nodeIds / sessionId，只在本机有意义：文件里带的
 * 一律丢弃，不进模板（契约 §121.3）。
 */
function withoutSource(draft: WorkflowDraft): WorkflowDraft {
  if (draft.source === undefined) return draft;
  const { source: _source, ...rest } = draft;
  return rest;
}

/**
 * 与 ama 读正文同一规则（按行切 `\r\n` / `\r` / `\n`，去掉首尾的空白行，用 `\n`
 * 连回去）：导出再导入不因换行或首尾空行而判成「有改动」。空正文等于没有。
 */
export function normalizeDescription(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length > 0 && (lines[0] as string).trim() === "") lines.shift();
  while (
    lines.length > 0 &&
    (lines[lines.length - 1] as string).trim() === ""
  ) {
    lines.pop();
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

/** 落库与比较用的形状：没有 `source`，`description` 规整过。 */
function comparable(draft: WorkflowDraft): WorkflowDraft {
  const { description, ...rest } = withoutSource(draft);
  const normal =
    description == null ? undefined : normalizeDescription(description);
  return normal === undefined ? rest : { ...rest, description: normal };
}

/* --------------------------------- 列表 --------------------------------- */

export async function listWorkflowFiles(
  workspace: Workspace,
  database: DatabaseSync,
): Promise<WorkflowFileEntry[]> {
  readable(workspace);
  let names: string[];
  try {
    const listing = await ran<{
      entries: { name: string; kind: string }[];
    }>(workspace, "files.list", { path: WORKFLOW_DIR });
    names = listing.entries
      .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length))
      .slice(0, MAX_FILES);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const entries: WorkflowFileEntry[] = [];
  for (let from = 0; from < names.length; from += READ_BATCH) {
    entries.push(
      ...(await Promise.all(
        names
          .slice(from, from + READ_BATCH)
          .map((id) => entryOf(workspace, database, id)),
      )),
    );
  }
  return entries;
}

async function entryOf(
  workspace: Workspace,
  database: DatabaseSync,
  id: string,
): Promise<WorkflowFileEntry> {
  const base = {
    id,
    path: workflowFilePath(id),
    templateId:
      templateByFileRef(database, fileRef(workspace.id, id))?.id ?? null,
  };
  const refused = (
    error: unknown,
    title: string | null,
  ): WorkflowFileEntry => ({
    ...base,
    title,
    valid: false,
    error: error instanceof Error ? error.message : String(error),
  });
  if (!FILE_ID_PATTERN.test(id)) {
    return refused("文件名不是合法的工作流 id。", null);
  }
  let text: string;
  try {
    text = await readText(workspace, base.path);
  } catch (error) {
    return refused(error, null);
  }
  const parsed = parseWorkflowFile(text);
  if (parsed.workflow === undefined) {
    return refused(firstIssue(parsed.issues), null);
  }
  try {
    parseDraft(parsed.workflow, RULES);
  } catch (error) {
    return refused(error, parsed.workflow.title);
  }
  return { ...base, title: parsed.workflow.title, valid: true, error: null };
}

/* --------------------------------- 读 --------------------------------- */

/** 读、ama 解析、`parseDraft`；答规整后的草案与原文的 sha256（与 ama 的 `source.hash` 同算法）。 */
export async function readWorkflowFile(
  workspace: Workspace,
  id: string,
): Promise<{ draft: WorkflowDraft; hash: string }> {
  readable(workspace);
  const path = workflowFilePath(checkFileId(id));
  if (!(await exists(workspace, path))) {
    throw new DomainError(404, "not_found", `没有 ${path}。`);
  }
  const text = await readText(workspace, path);
  return { draft: draftOfText(text), hash: textHash(text) };
}

async function exists(workspace: Workspace, path: string): Promise<boolean> {
  return (await versionOf(workspace, path)).exists;
}

async function versionOf(
  workspace: Workspace,
  path: string,
): Promise<{ exists: boolean; sha256?: string | null | undefined }> {
  try {
    return await ran<{ exists: boolean; sha256?: string | null }>(
      workspace,
      "files.version",
      { path },
    );
  } catch (error) {
    if (missing(error)) return { exists: false };
    throw error;
  }
}

/* --------------------------------- 写 --------------------------------- */

const DEFAULT_PARAM_TYPE = "string";
const DEFAULT_LINK_ROLE = "peer";

type Json = Record<string, unknown>;

/** 去掉 `null`、`undefined` 与空对象；不动数组里的字符串（glob 原样）。 */
function pruned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruned);
  if (value === null || typeof value !== "object") return value;
  const out: Json = {};
  for (const [key, entry] of Object.entries(value as Json)) {
    if (entry === null || entry === undefined) continue;
    out[key] = pruned(entry);
  }
  return out;
}

/** 草案 → ama 文档：不写回缺省值，空的 `contract` 不写，`source` 不写。 */
function documentOf(draft: WorkflowDraft): unknown {
  const doc = pruned(withoutSource(draft)) as Json;
  doc.version = WORKFLOW_FORMAT_VERSION;
  if (Array.isArray(doc.params)) {
    doc.params = (doc.params as Json[]).map((param) => {
      const { type, ...rest } = param;
      return type === DEFAULT_PARAM_TYPE ? rest : param;
    });
  }
  if (Array.isArray(doc.links)) {
    doc.links = (doc.links as Json[]).map((link) => {
      const { role, ...rest } = link;
      return role === DEFAULT_LINK_ROLE ? rest : link;
    });
  }
  if (Array.isArray(doc.steps)) {
    doc.steps = (doc.steps as Json[]).map((step) => {
      const { after, ...rest } = step;
      return Array.isArray(after) && after.length === 0 ? rest : step;
    });
  }
  // 空的 `contract` 不写（ama 拒绝 `{}`）；`source` 不导出，见 withoutSource。
  const contract = doc.contract;
  if (contract !== undefined && Object.keys(contract as Json).length === 0) {
    delete doc.contract;
  }
  return doc;
}

/** 先 `validateWorkflow`，再 `formatWorkflowFile`；不过回 `400 invalid_draft`，消息是 ama 的第一条问题。 */
export function formatDraft(draft: WorkflowDraft): string {
  const checked = validateWorkflow(documentOf(draft));
  if (!checked.ok) {
    throw new DomainError(400, "invalid_draft", firstIssue(checked.errors));
  }
  return formatWorkflowFile(checked.workflow);
}

async function ensureDirectory(
  workspace: Workspace,
  path: string,
): Promise<void> {
  try {
    await ran(workspace, "files.create", { path, kind: "directory" });
  } catch (error) {
    // 已经在了；是文件挡着时，下面写文件会说清楚。
    if (error instanceof DomainError && error.status === 409) return;
    throw error;
  }
}

export async function writeWorkflowFile(
  workspace: Workspace,
  id: string,
  draft: WorkflowDraft,
  overwrite: boolean,
): Promise<{ path: string }> {
  writable(workspace);
  const path = workflowFilePath(checkFileId(id));
  const content = formatDraft(draft);
  const current = await versionOf(workspace, path);
  if (current.exists && !overwrite) {
    throw new DomainError(409, "workflow_file_exists", `${path} 已经存在。`);
  }
  await ensureDirectory(workspace, ".ama");
  await ensureDirectory(workspace, WORKFLOW_DIR);
  await ran(workspace, "files.write", {
    path,
    content,
    ...(current.exists && current.sha256 != null
      ? { expectedSha256: current.sha256 }
      : {}),
    bom: false,
  });
  return { path };
}

/** 导出时没给 id：文件引用里的，再取名字的 ASCII 短横线形式，再取 `workflow-<模板 id 前 8 位>`。 */
export function defaultFileId(template: TemplateRow): string {
  const fromRef = template.fileRef?.split("/").slice(1).join("/");
  if (fromRef !== undefined && FILE_ID_PATTERN.test(fromRef)) return fromRef;
  const slug = template.name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (FILE_ID_PATTERN.test(slug)) return slug;
  return `workflow-${template.id.slice(0, 8)}`;
}

/**
 * 导出时没给 id 用的文件 id：默认值的文件引用已经属于另一个模板时，补
 * `-<模板 id 前 8 位>`，不让导出悄悄抢别人的文件（总长仍在 32 以内）。
 */
export function exportFileId(
  database: DatabaseSync,
  workspaceId: string,
  template: TemplateRow,
): string {
  const id = defaultFileId(template);
  const owner = templateByFileRef(database, fileRef(workspaceId, id));
  if (owner === undefined || owner.id === template.id) return id;
  const suffix = `-${template.id.slice(0, 8)}`;
  return `${id.slice(0, 32 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/* --------------------------------- 模板 --------------------------------- */

/**
 * 导入与托管运行共用：没有就建，有且正文不同就修订号 +1，相同原样。名字跟着标题走
 * （人改过名字的保留）。
 */
export function upsertFileTemplate(
  database: DatabaseSync,
  ref: string,
  incoming: WorkflowDraft,
  now: number,
): { readonly template: TemplateRow; readonly change: FileChange } {
  const draft = comparable(incoming);
  const current = templateByFileRef(database, ref);
  if (current === undefined) {
    return {
      template: insertTemplate(database, {
        id: uuidV7(now),
        name: draft.title,
        template: draft,
        createdFromDraft: null,
        fileRef: ref,
        createdAt: now,
      }),
      change: "created",
    };
  }
  // `source` 属于库里这份模板（本机画布上的来历），文件改动不动它。
  if (isDeepStrictEqual(comparable(current.template), draft)) {
    return { template: current, change: "unchanged" };
  }
  const name =
    current.name === current.template.title ? draft.title : current.name;
  const kept = current.template.source;
  updateTemplate(
    database,
    current.id,
    name,
    kept === undefined ? draft : { ...draft, source: kept },
    now,
    current.version,
  );
  return {
    template: templateByFileRef(database, ref) as TemplateRow,
    change: "updated",
  };
}
