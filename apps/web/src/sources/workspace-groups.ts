import type { SourceConnection } from "./connection";
import { originOf } from "./origin";
import type { SourceState } from "./types";
import type { CachedWorkspace } from "./workspace-cache";

/**
 * 侧栏的三组（#301）：这台电脑、我的其他电脑、他人分享。纯函数，组件与测试
 * 共用；每台电脑一段，各自带列表状态——一台在连、一台离线都只影响它那一段，
 * 不挡本机。
 */

export type WorkspaceGroupKey = "local" | "mine" | "shared";

export const WORKSPACE_GROUP_ORDER: readonly WorkspaceGroupKey[] = [
  "local",
  "mine",
  "shared",
];

/**
 * 一台电脑那一段的列表状态：`ready` 列出的是实时的；`loading` 在连或在取，
 * `offline` 连不上、要登录——这两种列的是上次记下的（灰着、点不开）。
 */
export type SectionState = "ready" | "loading" | "offline";

export interface SourceSection {
  readonly connection: SourceConnection;
  readonly state: SectionState;
  readonly workspaces: readonly CachedWorkspace[];
  /** `workspaces` 来自上次的记录（不是这次列出的）。 */
  readonly stale: boolean;
}

export interface WorkspaceGroup {
  readonly key: WorkspaceGroupKey;
  readonly sections: readonly SourceSection[];
}

/** 一台电脑的工作空间查询（`useWorkspaces().perSource`）。 */
export interface SourceListing {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly workspaces: readonly CachedWorkspace[];
}

export interface GroupInput {
  readonly sources: readonly SourceConnection[];
  /** 各源的连接状态（本机不看）。 */
  readonly states: Readonly<Record<string, SourceState>>;
  /** 就绪的源这一次列出的；没发查询的源不在里面。 */
  readonly listings: ReadonlyMap<string, SourceListing>;
  /** 上次记下的工作空间名。 */
  readonly cached: (sourceId: string) => readonly CachedWorkspace[];
}

export function groupKeyOf(connection: SourceConnection): WorkspaceGroupKey {
  if (connection.descriptor.kind === "local") return "local";
  return originOf(connection.descriptor) === "shared" ? "shared" : "mine";
}

function sectionOf(
  connection: SourceConnection,
  input: GroupInput,
): SourceSection {
  const sourceId = connection.descriptor.sourceId;
  const local = connection.descriptor.kind === "local";
  const state: SourceState = local
    ? "ready"
    : (input.states[sourceId] ?? connection.status.state);
  const listing = input.listings.get(sourceId);
  const fallback = (sectionState: SectionState): SourceSection => ({
    connection,
    state: sectionState,
    workspaces: local ? (listing?.workspaces ?? []) : input.cached(sourceId),
    stale: !local,
  });
  if (state === "offline" || state === "unauthorized")
    return fallback("offline");
  if (state !== "ready") return fallback("loading");
  if (listing === undefined || listing.isPending) return fallback("loading");
  if (listing.isError) return fallback("offline");
  return {
    connection,
    state: "ready",
    workspaces: listing.workspaces,
    stale: false,
  };
}

/** 按归属分三组；组内保持源表顺序（本机在前，其余按 `orderIndex`）。空组不出现。 */
export function groupWorkspaces(input: GroupInput): WorkspaceGroup[] {
  const groups = new Map<WorkspaceGroupKey, SourceSection[]>();
  for (const connection of input.sources) {
    const key = groupKeyOf(connection);
    const list = groups.get(key) ?? [];
    list.push(sectionOf(connection, input));
    groups.set(key, list);
  }
  return WORKSPACE_GROUP_ORDER.filter((key) => groups.has(key)).map((key) => ({
    key,
    sections: groups.get(key)!,
  }));
}

/** 名字的首字母（头像用）：取第一个字形并大写；空名用 `?`。 */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? "?" : first.toLocaleUpperCase();
}

/** 一台电脑的名字：改过的名字，没有就用它自己报的主机名，再没有用标识。 */
export function sourceNameOf(connection: SourceConnection): string {
  return (
    connection.descriptor.label ||
    connection.hello?.hostName ||
    connection.descriptor.defaultLabel ||
    connection.descriptor.sourceId
  );
}

/**
 * 分享来的电脑的主人：源表报的主人名，其次那台 core `system.hello` 报的
 * `ownerName`（契约 §68，旧 core 没有），再退回电脑的名字。
 */
export function ownerNameOf(connection: SourceConnection): string {
  const hello = connection.hello as { ownerName?: unknown } | null;
  const fromHello =
    typeof hello?.ownerName === "string" && hello.ownerName.trim() !== ""
      ? hello.ownerName.trim()
      : undefined;
  return (
    connection.descriptor.ownerName ?? fromHello ?? sourceNameOf(connection)
  );
}
