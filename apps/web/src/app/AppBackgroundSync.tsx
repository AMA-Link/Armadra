import { useAgentStatusHydration } from "../agent/hydration";
import { useHostNeedsSync } from "../notifications/use-host-needs";
import { useHumanNeedsSync } from "../notifications/use-human-needs";
import { useCanvasStore } from "../store/canvas-store";
import { useAgentModesMirror } from "./use-agent-modes-mirror";
import { useUsagePolicyNotice } from "./use-usage-policy-notice";

/**
 * 壳里那些只做同步、不画任何东西的 hook，收在这个不渲染的叶子里。
 *
 * 它们订阅的东西变得很勤：会话状态镜像、会话列表与交接查询、额度缓存、
 * 设置缓存。住在 `AppShell` 里时，一次会话状态跳动就让整个应用壳（近三千个
 * 组件）重渲；挪到叶子上，同样的订阅只重渲这一个返回 null 的组件。
 */
export function AppBackgroundSync(): null {
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  useAgentStatusHydration(workspaceId);
  useHumanNeedsSync();
  useHostNeedsSync();
  useUsagePolicyNotice();
  useAgentModesMirror();
  return null;
}
