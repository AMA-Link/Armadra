import { create } from "zustand";

/** 要分享的那块工作空间（只在这台电脑上的；别人的不能再分享）。 */
export interface ShareRequest {
  readonly workspaceId: string;
  readonly workspaceName: string;
}

interface ShareState {
  readonly request: ShareRequest | null;
  open(request: ShareRequest): void;
  close(): void;
}

/**
 * 分享弹层开着没有、分享的是哪块（#301 B5）。两个入口——工作空间菜单与画布
 * 右上工具簇的「分享」——都只往这里写，弹层只挂一份（`app/Overlays`）。
 */
export const useShareStore = create<ShareState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function openShare(request: ShareRequest): void {
  useShareStore.getState().open(request);
}
