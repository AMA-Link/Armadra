import { useEffect, useMemo, useState } from "react";

import type { GitTarget } from "../../../git/gateway";
import { gitGateway } from "../../../git/gateway";

/**
 * 页面这一侧的头像缓存（#942）：按 GitHub 账号 id 逐个记，侧栏与画布上的 Git
 * 节点共用一份。翻页时只问还没有的 id，一批至多 50 个，问完再问下一批；问
 * 不到的（离线、开关关了）也记下，半小时后才再问。core 那边还有一层落盘缓存。
 */

const BATCH = 50;
const MISS_TTL = 30 * 60 * 1000;

interface Entry {
  readonly dataUrl: string | null;
  readonly at: number;
}

const cache = new Map<number, Entry>();
const inflight = new Set<number>();
const listeners = new Set<() => void>();

function known(id: number, now: number): boolean {
  const entry = cache.get(id);
  if (!entry) return false;
  return entry.dataUrl !== null || now - entry.at < MISS_TTL;
}

async function fetchBatch(target: GitTarget, ids: number[]): Promise<void> {
  for (const id of ids) inflight.add(id);
  try {
    const answer = await gitGateway.avatars(target, ids);
    const now = Date.now();
    for (const { id, dataUrl } of answer.avatars) {
      cache.set(id, { dataUrl, at: now });
    }
  } catch {
    const now = Date.now();
    for (const id of ids) cache.set(id, { dataUrl: null, at: now });
  } finally {
    for (const id of ids) inflight.delete(id);
    for (const listener of listeners) listener();
  }
}

/** 测试用：清空页面缓存。 */
export function resetAvatarCache(): void {
  cache.clear();
  inflight.clear();
}

export function useAvatars(
  target: GitTarget,
  ids: readonly number[],
): ReadonlyMap<number, string> {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const missingKey = useMemo(() => {
    const now = Date.now();
    return ids
      .filter((id) => !known(id, now) && !inflight.has(id))
      .slice(0, BATCH)
      .join(",");
    // `version` 变了（一批回来了）就重新看还缺哪些。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version]);

  useEffect(() => {
    if (missingKey === "") return;
    void fetchBatch(target, missingKey.split(",").map(Number));
    // target 只用来定位工作空间；换了工作空间 ids 也会跟着变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  return useMemo(() => {
    const map = new Map<number, string>();
    for (const id of ids) {
      const dataUrl = cache.get(id)?.dataUrl;
      if (dataUrl) map.set(id, dataUrl);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version]);
}
