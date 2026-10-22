/**
 * 终端驱动的 Agent 节点的节点体：终端画面，或只读的会话内容（时间线）。
 * 切换的是「看什么」，不切换驱动（设计 §5.3）；缺省是终端。只在本机页面里记，
 * 不进画布数据（那是每个设备自己的看法，别人不跟着变）。
 */
import { create } from "zustand";

import { scoped } from "../sources/scope";

export type NodeBodyMode = "terminal" | "session";

interface NodeBodyState {
  readonly modes: Readonly<Record<string, NodeBodyMode>>;
  set: (nodeId: string, mode: NodeBodyMode) => void;
}

export const useNodeBodyStore = create<NodeBodyState>((set) => ({
  modes: {},
  set: (nodeId, mode) =>
    set((state) =>
      state.modes[scoped(nodeId)] === mode
        ? state
        : { modes: { ...state.modes, [scoped(nodeId)]: mode } },
    ),
}));

/**
 * 节点建出来时记的初始节点体（`agent.view`，设计 §5.4）；没写就是终端。
 * 本机手动切换过的优先，所以后来改偏好或别的设备切换都不会盖掉它。
 */
export function initialBodyMode(
  agent: { readonly view?: NodeBodyMode } | undefined,
): NodeBodyMode {
  return agent?.view === "session" ? "session" : "terminal";
}

export function useNodeBodyMode(
  nodeId: string,
  agent?: { readonly view?: NodeBodyMode },
): NodeBodyMode {
  return useNodeBodyStore(
    (state) => state.modes[scoped(nodeId)] ?? initialBodyMode(agent),
  );
}

export function nodeBodyMode(
  nodeId: string,
  agent?: { readonly view?: NodeBodyMode },
): NodeBodyMode {
  return (
    useNodeBodyStore.getState().modes[scoped(nodeId)] ?? initialBodyMode(agent)
  );
}
