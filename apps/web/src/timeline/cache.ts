/**
 * 时间线的本地缓存（设计 §2.6、§4）：IndexedDB 存快照与 `seq`，下次打开先用它渲染，
 * 再 `timeline.sync(after = seq)`。按 `(sourceId, timelineId)` 分键，LRU 保留 64 条
 * 时间线或 128 MiB，先到的为准。
 *
 * 存储后端是接口：浏览器用 {@link createIdbBackend}，测试与不支持 IndexedDB 的环境
 * 用 {@link createMemoryBackend}。缓存读写失败一律静默——缓存只是加速，不是真相。
 */
import type { TimelineHead, TimelineItem, TurnIndex } from "@armadra/shared";

export const CACHE_MAX_ENTRIES = 64;
export const CACHE_MAX_BYTES = 128 * 1024 * 1024;

/** 一条缓存：已加载的那一段条目 + 回合索引 + 头部值 + 游标。 */
export interface CachedTimeline {
  readonly key: string;
  readonly seq: number;
  readonly head: TimelineHead;
  readonly headRev: number;
  readonly items: readonly TimelineItem[];
  readonly turns: readonly TurnIndex[];
  /** 已加载的最早回合；更早的还要翻页取。 */
  readonly oldestLoadedTurn: number;
  /** 最近一次读写，LRU 用。 */
  readonly touchedAt: number;
  /** 序列化后的近似字节数。 */
  readonly bytes: number;
}

export interface CacheBackend {
  get(key: string): Promise<CachedTimeline | undefined>;
  put(entry: CachedTimeline): Promise<void>;
  delete(key: string): Promise<void>;
  /** 只含 LRU 记账需要的字段。 */
  list(): Promise<
    readonly Pick<CachedTimeline, "key" | "touchedAt" | "bytes">[]
  >;
}

export function cacheKey(sourceId: string, timelineId: string): string {
  return `${sourceId}\u0000${timelineId}`;
}

export function approxBytes(
  items: readonly TimelineItem[],
  extra: unknown,
): number {
  let size = JSON.stringify(extra).length;
  for (const item of items) size += JSON.stringify(item).length;
  return size * 2;
}

export function createMemoryBackend(): CacheBackend {
  const map = new Map<string, CachedTimeline>();
  return {
    get: async (key) => map.get(key),
    put: async (entry) => {
      map.set(entry.key, entry);
    },
    delete: async (key) => {
      map.delete(key);
    },
    list: async () =>
      [...map.values()].map(({ key, touchedAt, bytes }) => ({
        key,
        touchedAt,
        bytes,
      })),
  };
}

const DB_NAME = "armadra-timeline";
const STORE = "timelines";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB 后端；环境里没有 `indexedDB` 时答 `null`。 */
export function createIdbBackend(): CacheBackend | null {
  if (typeof indexedDB === "undefined") return null;
  let opening: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    opening ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(STORE, { keyPath: "key" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return opening;
  };
  const store = async (mode: IDBTransactionMode) =>
    (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    get: async (key) =>
      (await request((await store("readonly")).get(key))) as
        | CachedTimeline
        | undefined,
    put: async (entry) => {
      await request((await store("readwrite")).put(entry));
    },
    delete: async (key) => {
      await request((await store("readwrite")).delete(key));
    },
    list: async () => {
      const all = (await request(
        (await store("readonly")).getAll(),
      )) as CachedTimeline[];
      return all.map(({ key, touchedAt, bytes }) => ({
        key,
        touchedAt,
        bytes,
      }));
    },
  };
}

export interface TimelineCache {
  load(
    sourceId: string,
    timelineId: string,
  ): Promise<CachedTimeline | undefined>;
  save(
    sourceId: string,
    timelineId: string,
    value: Omit<CachedTimeline, "key" | "touchedAt" | "bytes">,
  ): Promise<void>;
  remove(sourceId: string, timelineId: string): Promise<void>;
}

export interface CacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

/** LRU 缓存：写入后按 `touchedAt` 从旧到新淘汰，直到条数和字节数都在上限内。 */
export function createTimelineCache(
  backend: CacheBackend | null,
  options: CacheOptions = {},
): TimelineCache {
  const maxEntries = options.maxEntries ?? CACHE_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  const quiet = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch {
      // 缓存只是加速。
    }
  };
  return {
    load: async (sourceId, timelineId) => {
      if (backend === null) return undefined;
      const key = cacheKey(sourceId, timelineId);
      try {
        const entry = await backend.get(key);
        if (entry === undefined) return undefined;
        await quiet(() => backend.put({ ...entry, touchedAt: now() }));
        return entry;
      } catch {
        return undefined;
      }
    },
    save: async (sourceId, timelineId, value) => {
      if (backend === null) return;
      const key = cacheKey(sourceId, timelineId);
      await quiet(async () => {
        const bytes = approxBytes(value.items, {
          head: value.head,
          turns: value.turns,
        });
        if (bytes > maxBytes) {
          await backend.delete(key);
          return;
        }
        await backend.put({ ...value, key, touchedAt: now(), bytes });
        const rows = [...(await backend.list())].sort(
          (a, b) => a.touchedAt - b.touchedAt,
        );
        let total = rows.reduce((sum, row) => sum + row.bytes, 0);
        let count = rows.length;
        for (const row of rows) {
          if (count <= maxEntries && total <= maxBytes) break;
          if (row.key === key) continue;
          await backend.delete(row.key);
          count--;
          total -= row.bytes;
        }
      });
    },
    remove: async (sourceId, timelineId) => {
      if (backend === null) return;
      await quiet(() => backend.delete(cacheKey(sourceId, timelineId)));
    },
  };
}

let pageCache: TimelineCache | undefined;

/** 页面的缓存（IndexedDB；没有就等于不缓存）。 */
export function timelineCache(): TimelineCache {
  pageCache ??= createTimelineCache(createIdbBackend());
  return pageCache;
}

/** 测试：换缓存；不传则复原。 */
export function setTimelineCache(next?: TimelineCache): void {
  pageCache = next;
}
