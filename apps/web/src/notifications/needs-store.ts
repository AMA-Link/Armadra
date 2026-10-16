import { create } from "zustand";

import type { NeedItem, NeedWorkspaceGroup } from "./needs";

/**
 * 当前「需要人处理」的清单。由 `useHumanNeedsSync`（App 挂一次）写入，铃铛
 * 徽标、面板和系统通知的点击跳转都读它，所以三处永远是同一份。
 */
interface NeedsState {
  items: NeedItem[];
  groups: NeedWorkspaceGroup[];
  /** 切到那个工作空间和画布并定位节点；由同步 hook 接上。 */
  open: (item: Pick<NeedItem, "workspaceId" | "boardId" | "nodeId">) => void;
  set: (items: NeedItem[], groups: NeedWorkspaceGroup[]) => void;
  setOpen: (open: NeedsState["open"]) => void;
}

export const useNeedsStore = create<NeedsState>((set) => ({
  items: [],
  groups: [],
  open: () => undefined,
  set: (items, groups) => set({ items, groups }),
  setOpen: (open) => set({ open }),
}));

export const selectNeedCount = (state: NeedsState): number =>
  state.items.length;
