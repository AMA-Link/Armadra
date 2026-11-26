import { create } from "zustand";

/**
 * 刚新开、还没出现在任何板文档里的会话：core 起进程之后才把 `sessionId` 写进
 * 节点并发 `board.changed`，这段时间列表要先把它画出来。
 */
export interface StartingSession {
  readonly nodeId: string;
  readonly boardId: string;
  readonly title: string;
  readonly agentId: string;
  readonly driver: "terminal" | "acp";
}

interface SessionPageState {
  readonly open: boolean;
  readonly selectedNodeId: string | null;
  readonly starting: readonly StartingSession[];
  show(nodeId?: string): void;
  close(): void;
  toggle(): void;
  select(nodeId: string | null): void;
  addStarting(session: StartingSession): void;
}

/** 会话页（Armadra#1062）：开关、选中的会话、刚新开的会话。 */
export const useSessionPage = create<SessionPageState>((set) => ({
  open: false,
  selectedNodeId: null,
  starting: [],
  show: (nodeId) =>
    set((state) => ({
      open: true,
      selectedNodeId: nodeId ?? state.selectedNodeId,
    })),
  close: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
  select: (nodeId) => set({ selectedNodeId: nodeId }),
  addStarting: (session) =>
    set((state) => ({
      starting: [
        ...state.starting.filter((item) => item.nodeId !== session.nodeId),
        session,
      ],
      selectedNodeId: session.nodeId,
    })),
}));
