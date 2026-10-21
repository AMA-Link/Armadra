/**
 * 本页已经答过的审批 / elicitation：先收起卡片再等 core 的回执（下一条条目更新未必
 * 立刻到，不能让人对着答过的请求再点）。条目本身的状态以 core 为准；这里只是答复
 * 发出到回执到达之间的那一小段。
 */
import { create } from "zustand";

interface AnsweredState {
  readonly ids: ReadonlySet<string>;
  mark: (pendingId: string) => void;
  /** 没答上：把卡放回去。 */
  unmark: (pendingId: string) => void;
  reset: () => void;
}

export const useAnsweredStore = create<AnsweredState>((set) => ({
  ids: new Set(),
  mark: (pendingId) =>
    set((state) =>
      state.ids.has(pendingId)
        ? state
        : { ids: new Set([...state.ids, pendingId]) },
    ),
  unmark: (pendingId) =>
    set((state) => {
      if (!state.ids.has(pendingId)) return state;
      const ids = new Set(state.ids);
      ids.delete(pendingId);
      return { ids };
    }),
  reset: () => set({ ids: new Set() }),
}));
