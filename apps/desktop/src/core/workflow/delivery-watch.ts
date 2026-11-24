import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../bus";
import { loadNode } from "../collab/nodes";
import { parentsOf } from "./delivery-children";
import { deliveryNode } from "./delivery-facts";
import { nodesOfPull as linkedNodesOfPull } from "./node-pulls";
import type { Thread } from "./task-runs";

/**
 * 交付状态的推送（Armadra#988）：Agent 状态、工作项、PR 快照任何一个变了，就重算
 * 受影响节点的栏与短语，**变了才发** `delivery.changed`。内存里只记 `nodeId →
 * "lane|phrase"`：重启后第一次重算多发一帧，页面照常收敛。
 *
 * PR 细节变了而栏与短语没变时，发带 `pullsChanged` 的一帧，页面据此重读路由。
 * 子任务阶段（#995）：子节点的状态、工作项或工作流步骤变了，也重算它的父节点
 * （`parentsOf`），去重键带上子任务计数；计数没变而子节点集合变了，发带
 * `pullsChanged` 的一帧，页面重读路由。
 *
 * 它自己只订阅 `agent.status`、`workflow.task` 与 `workflow.run`，不处理
 * `delivery.changed`，没有回环；**不订阅 `board.changed`**（画板每次保存都发，
 * 太吵；连线变了要等下一个状态事件才收敛）。
 */

export interface DeliveryWatchOptions {
  readonly database: DatabaseSync;
  readonly bus: EventBus;
  readonly clock?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class DeliveryWatch {
  private readonly known = new Map<string, string>();
  /** 子节点集合的指纹：计数不变而集合变了，要让页面重读。 */
  private readonly members = new Map<string, string>();
  private off: (() => void) | undefined;

  constructor(private readonly options: DeliveryWatchOptions) {}

  start(): void {
    if (this.off !== undefined) return;
    this.off = this.options.bus.on("workspace.event", ({ event }) => {
      if (event.type === "agent.status") {
        const nodeId = (event.status as { nodeId?: unknown }).nodeId;
        if (typeof nodeId === "string") this.refreshWithParents([nodeId]);
      } else if (event.type === "workflow.task") {
        this.refreshWithParents([event.nodeId, event.coordinatorNodeId]);
      } else if (event.type === "workflow.run") {
        this.refreshWithParents(this.nodesOfRun(event.runId));
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    this.known.clear();
    this.members.clear();
  }

  /**
   * 这些节点自己与它们的父节点（工作项协调者、连线的主、`collect` 角色）。
   * 同一事件里先收齐再去重，每个节点只重算一次。
   */
  private refreshWithParents(nodeIds: readonly string[]): void {
    const targets = new Set<string>(nodeIds);
    for (const nodeId of nodeIds) {
      try {
        for (const parent of parentsOf(this.options.database, nodeId)) {
          targets.add(parent);
        }
      } catch (error) {
        this.options.log?.("交付状态没有找到父节点", {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const nodeId of targets) this.refresh(nodeId, false);
  }

  private nodesOfRun(runId: string): string[] {
    const rows = this.options.database
      .prepare(
        "SELECT DISTINCT node_id FROM workflow_run_steps WHERE run_id = ? AND node_id IS NOT NULL",
      )
      .all(runId) as { node_id: string }[];
    return rows.map((row) => row.node_id);
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
   * 绑了这个 PR 的节点，加上按分支关联到它的节点（`node-pulls.ts`，契约 §116），
   * 按节点去重。
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
    for (const nodeId of linkedNodesOfPull(
      this.options.database,
      repo,
      number,
    )) {
      nodes.add(nodeId);
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
        this.members.delete(nodeId);
        return;
      }
      const view = deliveryNode(
        this.options.database,
        nodeId,
        (this.options.clock ?? Date.now)(),
      );
      const counts =
        view.children === null
          ? null
          : {
              total: view.children.total,
              finished: view.children.finished,
              needsYou: view.children.needsYou,
            };
      const key =
        `${view.status.lane}|${view.status.phrase}|` +
        (counts === null
          ? "-"
          : `${counts.total}/${counts.finished}/${counts.needsYou}`);
      const changed = this.known.get(nodeId) !== key;
      const set = (view.children?.nodes ?? [])
        .map((child) => `${child.nodeId}:${child.source}`)
        .sort()
        .join(",");
      const setChanged = (this.members.get(nodeId) ?? "") !== set;
      if (!changed && !pullsTouched && !setChanged) return;
      this.known.set(nodeId, key);
      this.members.set(nodeId, set);
      const reread = pullsTouched || (setChanged && !changed);
      this.options.bus.emit("workspace.event", {
        workspaceId: node.workspaceId,
        event: {
          type: "delivery.changed",
          boardId: node.boardId,
          nodeId,
          lane: view.status.lane,
          phrase: view.status.phrase,
          ...(counts === null ? {} : { children: counts }),
          ...(reread ? { pullsChanged: true } : {}),
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
