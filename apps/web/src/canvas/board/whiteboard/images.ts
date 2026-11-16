import { routedFetch } from "@/api/source";
import { assetUrlFor } from "../../assets";

/**
 * 图片对象的位图缓存。文档里只有 `assetPath`；位图经它所属的源 `fetch` →
 * `createImageBitmap`（Bearer 的源带凭据，不污染画布）。没到位时 `peek` 返回
 * undefined 并开始加载，到位后通知重绘。
 */

type Entry = ImageBitmap | "failed";

const cache = new Map<string, Entry>();
const waiters = new Set<() => void>();
let workspace: string | null = null;

/** 换工作区后旧位图作废（路径相同的资产内容不一定相同）。 */
export function setImageWorkspace(id: string | null): void {
  if (workspace === id) return;
  workspace = id;
  for (const entry of cache.values()) {
    if (typeof entry !== "string") entry.close?.();
  }
  cache.clear();
  pending.clear();
}

export function onImageLoaded(listener: () => void): () => void {
  waiters.add(listener);
  return () => void waiters.delete(listener);
}

async function load(
  path: string,
  resolve?: (path: string) => string | null | undefined,
): Promise<ImageBitmap | null> {
  const url = resolve?.(path) ?? assetUrlFor(workspace, path);
  if (!url || typeof createImageBitmap !== "function") return null;
  try {
    const response = await routedFetch(url);
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

const pending = new Map<string, Promise<void>>();

function ensure(
  path: string,
  resolve?: (path: string) => string | null | undefined,
): Promise<void> {
  const running = pending.get(path);
  if (running) return running;
  const owner = workspace;
  const task = load(path, resolve).then((bitmap) => {
    pending.delete(path);
    if (owner !== workspace) return bitmap?.close?.();
    cache.set(path, bitmap ?? "failed");
    if (bitmap) for (const wake of [...waiters]) wake();
  });
  pending.set(path, task);
  return task;
}

/** 已就绪的位图；否则起一次加载，到位后通知重绘。 */
export function peekImage(path: string): ImageBitmap | undefined {
  const hit = cache.get(path);
  if (hit && typeof hit !== "string") return hit;
  if (!hit) void ensure(path);
  return undefined;
}

/** 等这些路径的位图都到位（导出前）。 */
export async function preloadImages(
  paths: readonly string[],
  resolve?: (path: string) => string | null | undefined,
): Promise<void> {
  await Promise.all(
    paths.filter((p) => !cache.has(p)).map((p) => ensure(p, resolve)),
  );
}
