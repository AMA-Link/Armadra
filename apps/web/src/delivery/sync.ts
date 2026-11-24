import { useEffect } from "react";

import { onWorkspaceConnection } from "@/api/events";
import { activeSourceId } from "@/sources/scope";
import { useCanvasStore } from "@/store/canvas-store";
import { useDeliveryBoard } from "./store";

/**
 * 常驻挂一次（`app/Overlays`）：当前画板变了就首读，连接重新连上就重读。
 * 节点头与面板都只读 store，不各自发请求。
 */
export function useDeliverySync(): void {
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const boardId = useCanvasStore((state) => state.boardId);
  useEffect(() => {
    if (workspaceId === null || boardId === null) {
      useDeliveryBoard.getState().reset();
      return;
    }
    void useDeliveryBoard.getState().refresh(workspaceId, boardId);
    return onWorkspaceConnection((id, connected, from) => {
      if (connected && id === workspaceId && from === activeSourceId()) {
        void useDeliveryBoard.getState().refresh(workspaceId, boardId);
      }
    });
  }, [workspaceId, boardId]);
}
