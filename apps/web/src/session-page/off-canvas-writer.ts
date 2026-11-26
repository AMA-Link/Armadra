import { errorCode, runtimeApi } from "@/api/client";
import type { NodeMutation } from "@/canvas/off-canvas-writer";

/** 撞上并发保存（409）最多重来几次。 */
const ATTEMPTS = 3;

/**
 * 会话页登记的离板写者的那一次写（#1071）：读这块板、改这个节点、按读到的
 * 版本号存回去。实时板上不带 `clientId` 的保存由 core 写进文档。
 */
export async function writeNodeOnBoard(
  workspaceId: string,
  boardId: string,
  nodeId: string,
  mutate: NodeMutation,
): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const document = await runtimeApi.loadBoard(workspaceId, boardId);
    const node = document.nodes.find((entry) => entry.id === nodeId);
    if (node === undefined) return;
    const next = mutate(node);
    if (next === null) return;
    try {
      await runtimeApi.saveBoard(workspaceId, boardId, {
        ...document,
        nodes: document.nodes.map((entry) =>
          entry.id === nodeId ? next : entry,
        ),
      });
      return;
    } catch (error) {
      if (errorCode(error) !== "conflict" || attempt === ATTEMPTS) throw error;
    }
  }
}
