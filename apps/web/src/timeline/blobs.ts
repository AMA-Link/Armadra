/**
 * 时间线里的 blob（图片、音频、二进制资源，设计 §3.2）怎么取。
 *
 * 渲染组件只认 `loadBlob(blobId)`；这里提供三种来源，按顺序：
 *
 *  1. 页面本地登记的（刚发出的附件）：内存里的 `Blob`，不走网络；
 *  2. `GET /api/timelines/{id}/blobs/{blobId}`：流式，不受一帧大小限制。经中转时一个
 *     RPC 应答就是一帧（约 786 KB 以内才装得下），所以大的 blob 只能走这条；
 *  3. `timeline.blob`（base64）：HTTP 取不到时的退路。
 *
 * blob 内容寻址，同一个 `blobId` 的字节永远不变，所以取回的 `Blob` 按 LRU 留一小批，
 * 页面重挂、列表回滚都不再取。
 */
import { TIMELINE_BLOB_PATH } from "@armadra/shared";

import { sourceById } from "@/api/source";

import { timelineTransportFor } from "./api";

/** 内存里最多留这么多个已取回的 blob。 */
const KEEP = 48;

const local = new Map<string, Blob>();
const fetched = new Map<string, Promise<Blob>>();
let localCounter = 0;

/** 登记一个页面本地的 `Blob`，答它的 `blobId`（前缀 `local:`，不会与 core 的 sha256 撞）。 */
export function putLocalBlob(blob: Blob): string {
  localCounter += 1;
  const id = `local:${localCounter.toString(36)}`;
  local.set(id, blob);
  return id;
}

/** base64 → `Blob`。 */
export function blobFromBase64(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function blobUrl(timelineId: string, blobId: string): string {
  return TIMELINE_BLOB_PATH.replace(
    "{timelineId}",
    encodeURIComponent(timelineId),
  ).replace("{blobId}", encodeURIComponent(blobId));
}

async function fetchBlob(
  sourceId: string,
  timelineId: string,
  blobId: string,
): Promise<Blob> {
  const source = sourceById(sourceId);
  try {
    const response = await source.fetch(
      `${source.httpBase}${blobUrl(timelineId, blobId)}`,
      { cache: "force-cache" },
    );
    if (response.ok) return await response.blob();
  } catch {
    // 网络错误：退到 RPC。
  }
  const wire = await timelineTransportFor(sourceId).blob(timelineId, blobId);
  return blobFromBase64(wire.data, wire.mimeType);
}

/** 某条时间线的 blob 读取函数；传给 `TimelineView` 的 `services.loadBlob`（引用稳定）。 */
export function createBlobLoader(
  sourceId: string,
  timelineId: string,
): (blobId: string) => Promise<Blob> {
  return (blobId) => {
    const own = local.get(blobId);
    if (own !== undefined) return Promise.resolve(own);
    const key = `${sourceId}\u0000${timelineId}\u0000${blobId}`;
    const hit = fetched.get(key);
    if (hit !== undefined) {
      // 最近用过：挪到队尾。
      fetched.delete(key);
      fetched.set(key, hit);
      return hit;
    }
    const pending = fetchBlob(sourceId, timelineId, blobId);
    fetched.set(key, pending);
    pending.catch(() => {
      if (fetched.get(key) === pending) fetched.delete(key);
    });
    while (fetched.size > KEEP) {
      const oldest = fetched.keys().next().value;
      if (oldest === undefined) break;
      fetched.delete(oldest);
    }
    return pending;
  };
}

/** 测试：清空登记与缓存。 */
export function resetBlobs(): void {
  local.clear();
  fetched.clear();
  localCounter = 0;
}
