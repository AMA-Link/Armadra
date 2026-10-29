import { create } from "zustand";

import type { DeviceEndorsement } from "@armadra/shared";

import type { NeedItem, NeedWorkspaceGroup } from "./needs";

/**
 * 当前「需要人处理」的清单。由 `useHumanNeedsSync`（App 挂一次）写入，铃铛
 * 徽标、面板和系统通知的点击跳转都读它，所以三处永远是同一份。
 */
interface NeedsState {
  items: NeedItem[];
  groups: NeedWorkspaceGroup[];
  /**
   * 主机级的条目（契约 §81.1）：不属于任何工作空间的设备背书，未读的，新的在前。
   * 只有 owner 有；由 `useHostNeedsSync` 写入。
   */
  host: DeviceEndorsement[];
  /** 主机级条目读到过一次（之前的空清单不代表「没有」；成员永远是 false）。 */
  hostSynced: boolean;
  /** 首批数据（工作空间与各自的会话、交接）是否已经同步过；之前的空清单不代表「没事」。 */
  synced: boolean;
  /** 切到那个工作空间和画布并定位节点；由同步 hook 接上。 */
  open: (item: Pick<NeedItem, "workspaceId" | "boardId" | "nodeId">) => void;
  set: (
    items: NeedItem[],
    groups: NeedWorkspaceGroup[],
    synced?: boolean,
  ) => void;
  setOpen: (open: NeedsState["open"]) => void;
  setHost: (host: DeviceEndorsement[]) => void;
}

export const useNeedsStore = create<NeedsState>((set) => ({
  items: [],
  groups: [],
  host: [],
  hostSynced: false,
  synced: false,
  open: () => undefined,
  set: (items, groups, synced = true) => set({ items, groups, synced }),
  setOpen: (open) => set({ open }),
  setHost: (host) => set({ host, hostSynced: true }),
}));

export const selectNeedCount = (state: NeedsState): number =>
  state.items.length + state.host.length;
