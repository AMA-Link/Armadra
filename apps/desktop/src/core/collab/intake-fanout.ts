import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceEvent } from "../bus";
import type { IntakeCandidate, SourceMode } from "../workflow/intake";
import { oneLine, recordRouterEvent } from "./router-events";
import type { CollabContext } from "./service";

/**
 * 候选怎么到协调者手里（契约 §104.4，#830）。
 *
 * 只写协调者的事件队列（`kind: "intake"`，id 与候选 id 相同），**不投任何成员**：
 * 候选还没人接，只有协调者要判定。概要一行：种类、线程、标题前 60 字、作者、
 * 模式、授权——不带正文，正文在协调者 `canvas intake --candidate` 时现读。
 * 写入经 `recordRouterEvent`，空闲的协调者由它的 `nudge` 拿到卡片（§93.2）。
 */

/** 事件表的 id 至多 200 字；候选 id 更长时截断，确认时按同一规则算。 */
export function intakeEventId(candidateId: string): string {
  return candidateId.slice(0, 200);
}

/** 卡片里那一行。 */
export function intakeSummary(
  candidate: Pick<
    IntakeCandidate,
    "kind" | "repo" | "number" | "title" | "author" | "authorized"
  >,
  mode: SourceMode,
): string {
  return [
    `候选 ${candidate.kind} ${candidate.repo}#${candidate.number}「${oneLine(candidate.title, 60)}」`,
    oneLine(candidate.author ?? "(未知作者)", 60),
    mode,
    candidate.authorized ? "已授权" : "未授权",
  ].join(" · ");
}

/** 写一条 `intake` 事件。答这次是不是新写的（重放不出第二条）。 */
export function recordIntakeEvent(
  context: CollabContext,
  candidate: IntakeCandidate,
  mode: SourceMode,
): boolean {
  return recordRouterEvent(context, {
    id: intakeEventId(candidate.id),
    coordinatorNodeId: candidate.coordinatorNodeId,
    kind: "intake",
    itemId: null,
    sourceNodeId: null,
    summary: intakeSummary(candidate, mode),
  });
}

/**
 * `workflow.intake` 帧（契约 §15.4）：新候选、判定、复核、接单各一帧，页面据此
 * 重读来源与候选。帧里不带标题与正文。协调者节点不在时不推。
 */
export function intakeEvent(
  database: DatabaseSync,
  candidate: Pick<IntakeCandidate, "id" | "sourceId" | "coordinatorNodeId">,
):
  | {
      readonly workspaceId: string;
      readonly event: Extract<WorkspaceEvent, { type: "workflow.intake" }>;
    }
  | undefined {
  const place = database
    .prepare(
      "SELECT n.board_id AS board_id, b.workspace_id AS workspace_id " +
        "FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .get(candidate.coordinatorNodeId) as
    | { board_id?: unknown; workspace_id?: unknown }
    | undefined;
  if (
    typeof place?.board_id !== "string" ||
    typeof place.workspace_id !== "string"
  ) {
    return undefined;
  }
  return {
    workspaceId: place.workspace_id,
    event: {
      type: "workflow.intake",
      boardId: place.board_id,
      coordinatorNodeId: candidate.coordinatorNodeId,
      candidateId: candidate.id,
      sourceId: candidate.sourceId,
    },
  };
}

export function publishIntake(
  database: DatabaseSync,
  publish: ((workspaceId: string, event: WorkspaceEvent) => void) | undefined,
  candidate: Pick<IntakeCandidate, "id" | "sourceId" | "coordinatorNodeId">,
): void {
  if (publish === undefined) return;
  const frame = intakeEvent(database, candidate);
  if (frame !== undefined) publish(frame.workspaceId, frame.event);
}
