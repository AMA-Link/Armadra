/**
 * 授予同步完了（#632）：`grantChanged` / 自己的 `memberChanged` 去抖之后重登成功，
 * 主机已按新断言整份同步授予。收窄时 core 会以 `forbidden` 结束失去的那块订阅，
 * 放宽却什么都不发——页面要自己重取一次工作空间列表，新放开的才出现。
 *
 * 源的入口（`console-host.ts`）在 `sources/` 里，看不到查询缓存，所以只在这里喊一声，
 * 由壳（`app/use-access-lost.ts`）让当前源的列表失效。只重取，不替人打开什么。
 */
const listeners = new Set<() => void>();

export function onGrantSynced(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceGrantSynced(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 一个订阅者出错不拖垮别的。 */
    }
  }
}
