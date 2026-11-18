import * as React from "react";

import {
  BROWSER_DEFAULT_BACKGROUND_MAX,
  usePreferencesStore,
} from "@/app/preferences-store";

/**
 * 浏览器节点的 ghost 池（electron-migration.md §4.1，W3.2）。
 *
 * 一个已挂载的 `<webview>` 宿主元素一旦被 React 移动（`insertBefore`），guest 当场
 * 被杀、整页重载。所以切工作空间、折叠分组、节点被丢出场景时，条目不离开场景，
 * 只变成 **ghost**：同一个 id、`display:none`、零面积、不可命中、不回写。guest
 * 因此毫发无损，回来时还是同一个进程、同一份页面状态。ghost 数量有上限，逐出
 * 最久退休的那个。
 *
 * 场景条目由画布适配器管（`canvas/board/board-adapter.ts`），这里只留两样：
 * 上限怎么算，以及「这个节点现在是不是 ghost」的订阅。
 */

/**
 * 后台（ghost）guest 上限的**默认值**。真正生效的是设置里的那一项。
 *
 * 逐出在每一次同步时判一遍，所以读在那时候发生：设置页把上限调小，下一帧
 * 就把多出来的 ghost 逐掉，不用等应用重启。
 *
 * 同一个上限在 `./background` 里先起一次作用，而且更早：超出上限的隐藏
 * guest 不等五分钟就被 `discard` 释放掉进程，节点、标签与地址都还在。到这
 * 里的逐出是更狠的那一步——条目离开池，React 卸载整棵子树，回来是一个全新
 * 的组件。两者说的是同一句话（「这台机器愿意为看不见的页面留几个」），顺
 * 序是先放进程、再放条目。
 */
export const BACKGROUND_WEBVIEW_MAX = BROWSER_DEFAULT_BACKGROUND_MAX;

/**
 * 池比 guest 预算多留几个**条目**。
 *
 * 两层用的是同一个设置项，但管的不是同一样东西：`./background` 管的是「几
 * 个后台页面还装着」（超出的释放进程，节点、标签、地址与缩略图都留着），这
 * 里管的是「几个后台节点还在池里」（超出的条目直接消失，回来是一个全新的组
 * 件，标签与地址从文档重新长出来）。
 *
 * 两者一样大的时候，池那一侧**总是先动手**——逐出在每一次同步时判，而回收
 * 的定时器十五秒才醒一次。实测：切走一块有五个浏览器节点的画布，上限 2，
 * 瞬间少掉三个 `<webview>`，而三个「已释放」占位一个都没出现。于是更狠的
 * 那一步永远先发生，温和的那一步形同虚设。
 *
 * 留出余量之后顺序就对了：先释放进程（便宜、可逆、看得见），条目要等到多
 * 出这么些个才离开池。余量是常数而不是比例——它回答的是「一个人在几块画布
 * 之间来回切时，手边大概有多少个浏览器节点」，那个数不随内存预算缩放。
 */
export const GHOST_ENTRY_HEADROOM = 8;

export function ghostEntryMax(): number {
  return (
    usePreferencesStore.getState().browser.backgroundMax + GHOST_ENTRY_HEADROOM
  );
}

let ghostIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 场景里留着 ghost 条目（宿主 DOM 与 `<webview>` 就还在），由画布适配器报告哪些
 * id 现在是 ghost；`useIsGhost` 据此让节点体不回写、不算可见性。
 */
export function setGhostIds(ids: ReadonlySet<string>): void {
  if (sameSet(ids, ghostIds)) return;
  ghostIds = ids;
  notify();
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/* --------------------------------- 订阅 ---------------------------------- */

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 这个节点现在是不是 ghost。
 *
 * 节点体靠它决定两件事：不要把事实回写进文档（ghost 的 `did-navigate` 属于
 * 另一个工作空间的页面，写回去就是把那份文档弄脏），以及不要再算可见性
 * ——ghost 永远是隐藏的。
 */
export function useIsGhost(id: string): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => ghostIds.has(id),
    () => false,
  );
}
