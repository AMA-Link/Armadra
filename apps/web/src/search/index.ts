/**
 * 搜索的索引与排序（纯逻辑，侧栏搜索与 ⌘K 共用）。
 *
 * 条目有四种：工作空间、画布、节点、白板对象。数据从哪来（工作空间列表、各画布
 * 文档）与怎么画都不在这里，这里只做「数据 → 条目」「查询 → 分组命中」，所以
 * 排序与摘取规则能按数据直接单测。
 */
import type { CanvasNode } from "@armadra/shared";

import type { WhiteboardDoc } from "@/canvas/whiteboard/model";
import { toItemId } from "@/canvas/whiteboard/model";
import {
  normalize,
  parseQuery,
  prepare,
  scoreFields,
  type Prepared,
} from "./match";

export type EntryKind = "workspace" | "board" | "node" | "item";

/** 条目的图标键；`SearchGroups` 把它映射到 lucide 图标。 */
export type EntryIcon =
  | "workspace"
  | "board"
  | "terminal"
  | "agent"
  | "sticky"
  | "group"
  | "editor"
  | "diff"
  | "files"
  | "browser"
  | "automation"
  | "activity"
  | "text"
  | "shape"
  | "image";

export interface SearchEntry {
  /** 全局唯一：`kind:工作空间:画布:对象`。 */
  id: string;
  kind: EntryKind;
  icon: EntryIcon;
  title: string;
  /** 可搜的正文（便签内容、路径、网址……），命中时摘一段显示。 */
  detail: string;
  workspaceId: string;
  workspaceName: string;
  boardId: string;
  boardName: string;
  /** 节点 id，或白板对象的 `wb:` id；工作空间与画布条目没有。 */
  targetId?: string;
  primary: Prepared;
  secondary: readonly Prepared[];
}

/** 每组最多列这么多条；超过靠继续输入收窄。 */
export const GROUP_LIMIT = 8;
/** 摘要长度，超出两端加省略号。 */
export const SNIPPET_LENGTH = 72;
/** 白板对象标题的长度。 */
const ITEM_TITLE_LENGTH = 60;

export interface WorkspaceRef {
  id: string;
  name: string;
}
export interface BoardRef {
  id: string;
  name: string;
}

export function workspaceEntries(
  workspaces: readonly WorkspaceRef[],
): SearchEntry[] {
  return workspaces.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    kind: "workspace",
    icon: "workspace",
    title: workspace.name,
    detail: "",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    boardId: "",
    boardName: "",
    primary: prepare(workspace.name),
    secondary: [],
  }));
}

export function boardEntries(
  workspace: WorkspaceRef,
  boards: readonly BoardRef[],
): SearchEntry[] {
  return boards.map((board) => ({
    id: `board:${workspace.id}:${board.id}`,
    kind: "board",
    icon: "board",
    title: board.name,
    detail: "",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    boardId: board.id,
    boardName: board.name,
    targetId: board.id,
    primary: prepare(board.name),
    // 画布也能用所在工作空间的名字找到（「设计稿 首页」）。
    secondary: [prepare(workspace.name)],
  }));
}

/** 节点的图标与可搜正文：只有便签有 `content`，其余取各自的路径 / 网址 / 目录。 */
function nodeFacets(node: CanvasNode): { icon: EntryIcon; detail: string } {
  const data = node.data;
  switch (data.kind) {
    case "sticky":
      return { icon: "sticky", detail: data.content };
    case "terminal":
      return {
        icon: data.agent ? "agent" : "terminal",
        detail: data.cwd ?? "",
      };
    case "group":
      return { icon: "group", detail: data.binding?.branch ?? "" };
    case "editor":
      return { icon: "editor", detail: data.path };
    case "diff":
      return { icon: "diff", detail: data.repoPath };
    case "files":
      return { icon: "files", detail: data.path };
    case "browser":
      return { icon: "browser", detail: data.url };
    case "automation":
      return { icon: "automation", detail: "" };
    case "agentActivity":
      return { icon: "activity", detail: "" };
    case "git":
      return { icon: "diff", detail: "" };
  }
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  return line.length > ITEM_TITLE_LENGTH
    ? `${line.slice(0, ITEM_TITLE_LENGTH)}…`
    : line;
}

/** 一块画布的文档 → 节点条目 + 白板对象条目。 */
export function documentEntries(input: {
  workspace: WorkspaceRef;
  board: BoardRef;
  nodes: readonly CanvasNode[];
  whiteboard: WhiteboardDoc | null;
}): SearchEntry[] {
  const { workspace, board, nodes, whiteboard } = input;
  const base = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    boardId: board.id,
    boardName: board.name,
  };
  const entries: SearchEntry[] = [];
  for (const node of nodes) {
    const { icon, detail } = nodeFacets(node);
    entries.push({
      ...base,
      id: `node:${workspace.id}:${board.id}:${node.id}`,
      kind: "node",
      icon,
      title: node.title,
      detail,
      targetId: node.id,
      primary: prepare(node.title),
      secondary: [detail, node.note, ...node.labels]
        .filter((text) => text !== "")
        .map(prepare),
    });
  }
  for (const item of whiteboard?.items ?? []) {
    let text = "";
    let icon: EntryIcon = "text";
    if (item.kind === "text") text = item.text;
    else if (item.kind === "shape") {
      text = item.label ?? "";
      icon = "shape";
    } else if (item.kind === "image") {
      text = item.alt ?? "";
      icon = "image";
    }
    if (text.trim() === "") continue;
    entries.push({
      ...base,
      id: `item:${workspace.id}:${board.id}:${item.id}`,
      kind: "item",
      icon,
      title: firstLine(text),
      detail: text,
      targetId: toItemId(item.id),
      primary: prepare(text),
      secondary: [],
    });
  }
  return entries;
}

/**
 * 正文里围绕第一个命中的词截一段；没有命中（或空词表）截开头。只压缩空白，
 * 不改标点。
 */
export function excerpt(
  text: string,
  terms: readonly string[],
  length: number = SNIPPET_LENGTH,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  if (at < 0) return `${flat.slice(0, length)}…`;
  const start = Math.max(0, at - Math.floor(length / 3));
  const end = Math.min(flat.length, start + length);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
  /** 命中靠的是正文时，正文里那一段。 */
  snippet?: string;
}

export interface SearchGroups {
  workspaces: SearchHit[];
  boards: SearchHit[];
  nodes: SearchHit[];
  items: SearchHit[];
}

/** 当前所在的工作空间与画布：同一块画布里的结果排前面。 */
export interface SearchContext {
  workspaceId: string | null;
  boardId: string | null;
}

const GROUP_OF: Record<EntryKind, keyof SearchGroups> = {
  workspace: "workspaces",
  board: "boards",
  node: "nodes",
  item: "items",
};

function nearness(entry: SearchEntry, context: SearchContext): number {
  if (entry.kind === "workspace")
    return entry.workspaceId === context.workspaceId ? 2 : 0;
  if (entry.workspaceId !== context.workspaceId) return 0;
  return entry.boardId === context.boardId ? 4 : 2;
}

/** 白板对象的标题只是正文第一行：命中落在后面的行时也要摘一段出来。 */
function missingFromTitle(
  entry: SearchEntry,
  terms: readonly string[],
): boolean {
  if (entry.kind !== "item") return false;
  const title = normalize(entry.title);
  return !terms.every((term) => title.includes(term));
}

/**
 * 条目 → 分组命中。空查询时不打分：工作空间与画布按给定顺序列出（当前工作空间
 * 的画布在前），节点只列当前画布的，白板对象不列——面板刚打开时有东西可选，
 * 但不是把所有画布的内容倒出来。
 */
export function searchEntries(
  entries: readonly SearchEntry[],
  query: string,
  context: SearchContext,
  limit: number = GROUP_LIMIT,
): SearchGroups {
  const terms = parseQuery(query);
  const groups: SearchGroups = {
    workspaces: [],
    boards: [],
    nodes: [],
    items: [],
  };

  if (terms.length === 0) {
    const boards = [...entries.filter((entry) => entry.kind === "board")];
    boards.sort(
      (a, b) =>
        Number(b.workspaceId === context.workspaceId) -
        Number(a.workspaceId === context.workspaceId),
    );
    const pick: Record<keyof SearchGroups, SearchEntry[]> = {
      workspaces: entries.filter((entry) => entry.kind === "workspace"),
      boards,
      nodes: entries.filter(
        (entry) =>
          entry.kind === "node" &&
          entry.workspaceId === context.workspaceId &&
          entry.boardId === context.boardId,
      ),
      items: [],
    };
    for (const key of Object.keys(pick) as (keyof SearchGroups)[])
      groups[key] = pick[key]
        .slice(0, limit)
        .map((entry) => ({ entry, score: 0 }));
    return groups;
  }

  const scored: Record<keyof SearchGroups, SearchHit[]> = {
    workspaces: [],
    boards: [],
    nodes: [],
    items: [],
  };
  for (const entry of entries) {
    const { score, viaSecondary } = scoreFields(
      terms,
      entry.primary,
      entry.secondary,
    );
    if (score <= 0) continue;
    const snippet =
      entry.detail && (viaSecondary || missingFromTitle(entry, terms))
        ? excerpt(entry.detail, terms)
        : "";
    const hit: SearchHit = {
      entry,
      score: score + nearness(entry, context),
      // 摘要与标题一样（单行白板文字）时不重复显示。
      ...(snippet && snippet !== entry.title ? { snippet } : {}),
    };
    scored[GROUP_OF[entry.kind]].push(hit);
  }
  for (const key of Object.keys(scored) as (keyof SearchGroups)[]) {
    // Array#sort 是稳定的：同分保持原顺序。
    groups[key] = scored[key].sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return groups;
}
