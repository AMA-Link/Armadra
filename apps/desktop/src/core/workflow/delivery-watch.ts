import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../bus";
import { loadNode } from "../collab/nodes";
import { deliveryNode } from "./delivery-facts";
import type { Thread } from "./task-runs";

/**
 * 交付状态的推送（Armadra#988）：Agent 状态、工作项、PR 快照任何一个变了，就重算
 * 受影响节点的栏与短语，**变了才发** `delivery.changed`。内存里只记 `nodeId →
 * "lane|phrase"`：重启后第一次重算多发一帧，页面照常收敛。
 *
 * PR 细节变了而栏与短语没变时，发带 `pullsChanged` 的一帧，页面据此重读路由。
 * 它自己只订阅 `agent.status` 与 `workflow.task`，不处理 `delivery.changed`，没有回环。
 */

export interface DeliveryWatchOptions {
  readonly database: DatabaseSync;
  readonly bus: EventBus;
  readonly clock?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class DeliveryWatch {
  private readonly known = new Map<string, string>();
  private off: (() => void) | undefined;

  constructor(private readonly options: DeliveryWatchOptions) {}

  start(): void {
    if (this.off !== undefined) return;
    this.off = this.options.bus.on("workspace.event", ({ event }) => {
      if (event.type === "agent.status") {
        const nodeId = (event.status as { nodeId?: unknown }).nodeId;
        if (typeof nodeId === "string") this.refresh(nodeId, false);
      } else if (event.type === "workflow.task") {
        this.refresh(event.nodeId, false);
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    this.known.clear();
  }

  /** PrWatch 的 `onSnapshot`：快照指纹变了（含首次）。 */
  onSnapshot = (repo: string, number: number): void => {
    for (const nodeId of this.nodesOfPull(repo, number)) {
      this.refresh(nodeId, true);
    }
  };

  /**
   * 节点关联的 PR 变了（P2 的 `NodePullLinker.onLinkChanged`）：PR 集合变了，
   * 页面要重读。
   */
  onLinkChanged = (nodeId: string): void => {
    this.refresh(nodeId, true);
  };

  /**
   * 绑了这个 PR 的节点。接缝（P2）：节点关联的 PR 经 `nodesOfPull(db, repo,
   * number)` 并入这里，按节点去重。
   */
  private nodesOfPull(repo: string, number: number): string[] {
    const rows = this.options.database
      .prepare(
        "SELECT node_id, threads FROM workflow_task_runs " +
          "WHERE threads IS NOT NULL AND threads <> '[]' " +
          "ORDER BY started_at DESC, rowid DESC",
      )
      .all() as { node_id: string; threads: string }[];
    const nodes = new Set<string>();
    const seen = new Set<string>();
    for (const row of rows) {
      // 只有节点最近的那个工作项算（`pullsOfNode` 也只看它）。
      if (seen.has(row.node_id)) continue;
      seen.add(row.node_id);
      let threads: readonly Thread[] = [];
      try {
        threads = JSON.parse(row.threads) as Thread[];
      } catch {
        continue;
      }
      if (
        threads.some(
          (thread) =>
            thread.kind === "pull" &&
            thread.repo === repo &&
            thread.number === number,
        )
      ) {
        nodes.add(row.node_id);
      }
    }
    return [...nodes];
  }

  /** 重算一个节点；变了才发。 */
  refresh(nodeId: string, pullsTouched: boolean): void {
    try {
      const node = loadNode(this.options.database, nodeId);
      if (
        node === undefined ||
        node.nodeType !== "terminal" ||
        node.agentId === null
      ) {
        this.known.delete(nodeId);
        return;
      }
      const view = deliveryNode(
        this.options.database,
        nodeId,
        (this.options.clock ?? Date.now)(),
      );
      const key = `${view.status.lane}|${view.status.phrase}`;
      const changed = this.known.get(nodeId) !== key;
      if (!changed && !pullsTouched) return;
      this.known.set(nodeId, key);
      this.options.bus.emit("workspace.event", {
        workspaceId: node.workspaceId,
        event: {
          type: "delivery.changed",
          boardId: node.boardId,
          nodeId,
          lane: view.status.lane,
          phrase: view.status.phrase,
          ...(pullsTouched ? { pullsChanged: true } : {}),
        },
      });
    } catch (error) {
      this.options.log?.("交付状态没有算成", {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
