import { create } from "zustand";

interface TrustDialogState {
  readonly open: boolean;
  show(): void;
  hide(): void;
}

/** 待信任对话框开着没有：横幅的「查看」打开它。 */
export const useTrustDialog = create<TrustDialogState>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
