import * as React from "react";

import { launchHold, whenDependenciesKnown } from "@/agent/dependency-store";
import { agentSessionRequest } from "@/agent/launch";
import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";

/** 同一个节点同时只起一次：重渲染、严格模式重跑、快速切换体都不会起第二个进程。 */
const starting = new Set<string>();

/**
 * 终端驱动的 Agent 节点用会话体显示时，没有终端表面替它起进程（设计 §5.4）。
 * 这里挂载时做表面 `ensureSession` 的同一个决定：节点上有活着或休眠的会话就什么
 * 都不做；没有（或已结束）就让 core 起 PTY 并自己敲启动行（`launch: true`），
 * 把会话 id 记回节点数据。表面之后再挂上（切到终端体）只是附着。
 *
 * 不起的情形与表面一致：控制器节点（`launchPolicy: "manual"`）、带
 * `pendingLaunch` 的、还在等依赖的（归 core 的依赖服务）。休眠的会话也不唤醒：
 * 投递会让 core 叫醒它，切到终端体可以点一下接回。
 */
export function useSessionBodyProcess(nodeId: string, enabled: boolean): void {
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  React.useEffect(() => {
    if (!enabled || workspaceId === null || starting.has(nodeId)) return;
    const data = () => {
      const node = useCanvasStore
        .getState()
        .document?.nodes.find((item) => item.id === nodeId);
      return node && node.data.kind === "terminal" ? node.data : undefined;
    };
    starting.add(nodeId);
    void (async () => {
      try {
        const first = data();
        if (!first?.agent || first.launchPolicy === "manual") return;
        if (first.agent.pendingLaunch) return;
        await whenDependenciesKnown(workspaceId);
        if (launchHold(workspaceId, nodeId) === "held") return;
        const existing = await sessionGateway.find(
          workspaceId,
          nodeId,
          first.sessionId,
        );
        if (existing?.state === "running" || existing?.state === "hibernated")
          return;
        const current = data();
        if (!current?.agent) return;
        const workspace = useCanvasStore.getState().workspace;
        const started = await sessionGateway.start({
          workspaceId,
          nodeId,
          cwd: current.cwd ?? workspace?.rootPath ?? "",
          ...(current.shell ? { shell: current.shell } : {}),
          ...(current.ssh ? { ssh: { hostId: current.ssh.hostId } } : {}),
          agent: agentSessionRequest(current.agent),
          launch: true,
        });
        useCanvasStore
          .getState()
          .updateNodeData(
            nodeId,
            { sessionId: started.sessionId, lastExitCode: null },
            { history: "ignore" },
          );
      } catch (cause) {
        console.warn("session body: could not start the node", cause);
        // 没起来：节点体保持空，切到终端体会走表面自己的失败展示与重试。
      } finally {
        starting.delete(nodeId);
      }
    })();
  }, [enabled, nodeId, workspaceId]);
}
