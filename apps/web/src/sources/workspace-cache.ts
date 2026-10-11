/**
 * 各台电脑上次列出的工作空间名（只存 id 与名字）：那台电脑离线、还在连时，
 * 侧栏照样把它们灰着列出来，人知道那边有什么。本机不记——本机的列表总在。
 */

const CACHE_KEY = "armadra.sources.workspaceNames";

/** 每台电脑最多记这么多个，免得本地存储无限长。 */
export const CACHED_WORKSPACES_PER_SOURCE = 50;

export interface CachedWorkspace {
  readonly id: string;
  readonly name: string;
}

type Cache = Record<string, readonly CachedWorkspace[]>;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is CachedWorkspace {
  if (!value || typeof value !== "object") return false;
  const { id, name } = value as { id?: unknown; name?: unknown };
  return typeof id === "string" && typeof name === "string";
}

function read(): Cache {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(CACHE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const cache: Cache = {};
    for (const [sourceId, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) cache[sourceId] = list.filter(isEntry);
    }
    return cache;
  } catch {
    return {};
  }
}

function write(cache: Cache): void {
  try {
    storage()?.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 存不下只是离线时少几行灰的。 */
  }
}

/** 这台电脑上次列出的工作空间；没记过是空数组。 */
export function cachedWorkspaces(sourceId: string): readonly CachedWorkspace[] {
  return read()[sourceId] ?? [];
}

/** 记下这台电脑刚列出的工作空间；与记着的相同就不写。 */
export function rememberWorkspaces(
  sourceId: string,
  workspaces: readonly CachedWorkspace[],
): void {
  const cache = read();
  const next = workspaces
    .slice(0, CACHED_WORKSPACES_PER_SOURCE)
    .map(({ id, name }) => ({ id, name }));
  if (JSON.stringify(cache[sourceId] ?? null) === JSON.stringify(next)) return;
  write({ ...cache, [sourceId]: next });
}

/** 那台电脑移走了：忘掉它的工作空间名。 */
export function forgetWorkspaces(sourceId: string): void {
  const cache = read();
  if (!(sourceId in cache)) return;
  delete cache[sourceId];
  write(cache);
}
