import { useMemo } from "react";

import { activeSourceId, unscoped } from "../sources/scope";
import { useCanvasStore } from "../store/canvas-store";
import { type AgentTree, agentTreeOf } from "./agent-tree-model";
import { type MirroredStatus, useAgentStatusStore } from "./status-store";
import { useAllSubagentCards } from "./subagent-store";

/**
 * 某个 Agent 节点的缩略树（`agentTreeOf` 的 React 入口）：读当前画布文档里的
 * `supervises` 边、状态镜像与子代理卡片。没有下级时是 `null`，调用方不渲染。
 *
 * `fallbackLabel`：根不在当前画布上时（通知面板里别的画布的节点）只凭它自己的
 * 子代理卡片成树。
 */
export function useAgentTree(
  rootId: string | null | undefined,
  fallbackLabel?: string,
): AgentTree | null {
  const document = useCanvasStore((state) => state.document);
  const statuses = useAgentStatusStore((state) => state.statuses);
  const cards = useAllSubagentCards();
  return useMemo(() => {
    if (!rootId) return null;
    // 状态镜像的键带来源前缀：只取当前源的，还原成节点 id。
    const here = activeSourceId();
    const byNode: Record<string, MirroredStatus> = {};
    for (const [key, status] of Object.entries(statuses)) {
      const { sourceId, id } = unscoped(key);
      if (sourceId === here) byNode[id] = status;
    }
    return agentTreeOf(rootId, document, byNode, cards, fallbackLabel);
  }, [rootId, document, statuses, cards, fallbackLabel]);
}
