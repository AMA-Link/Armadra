/**
 * 「接管已有会话」（P2-7）：新建菜单里，报了 `session/list` 能力的 Agent 多一项，
 * 选了在对话框里列出它自己历史里的会话，选一个就建出节点、`agent.sessionId` 记着
 * 那个会话 id，起会话时走已有的接回路径。
 *
 * 这个文件是对话框的开关与两个纯函数；菜单规格（`canvas/menus/add-menu.ts`）只
 * 依赖这里，对话框组件（`AttachSessionDialog.tsx`）再依赖菜单——不绕圈。
 */
import { create } from "zustand";
import type { AcpAgentSession, AgentInfo } from "@armadra/shared";

import type { AddMenuContext } from "@/canvas/menus/add-menu";

/** 菜单上是否给这家 Agent 一项「接管会话」：适配器装了，且最近一次协商报了 `list`。 */
export function attachable(agent: Pick<AgentInfo, "acp">): boolean {
  return agent.acp?.installed === true && agent.acp.capabilities?.list === true;
}

/**
 * 接管的会话在工作空间里的目录就带上，节点按它起；在工作空间之外的不带（节点
 * 的目录缺省是工作空间根，不把节点指到画布管不到的地方）。
 */
export function attachCwd(
  session: Pick<AcpAgentSession, "cwd">,
  rootPath: string,
): string | undefined {
  const cwd = session.cwd.replace(/[\\/]+$/, "");
  const root = rootPath.replace(/[\\/]+$/, "");
  if (cwd === "" || root === "") return undefined;
  return cwd === root ||
    cwd.startsWith(`${root}/`) ||
    cwd.startsWith(`${root}\\`)
    ? cwd
    : undefined;
}

export interface AttachRequest {
  readonly context: AddMenuContext;
  readonly agent: AgentInfo;
}

interface AttachState {
  request: AttachRequest | null;
  open: (request: AttachRequest) => void;
  close: () => void;
}

export const useAttachSessionStore = create<AttachState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function openAttachSession(
  context: AddMenuContext,
  agent: AgentInfo,
): void {
  useAttachSessionStore.getState().open({ context, agent });
}
