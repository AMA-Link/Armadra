import type { AgentDriver } from "@armadra/shared";
import { ensureSessionBoard } from "../canvas/boards";
import { loadBoard, saveBoard } from "../canvas/documents";
import type { CanvasNode } from "../canvas/document-types";
import { newNodeView } from "../collab/control/agent-driver";
import { newNode } from "../collab/control/board";
import { nameFor, withHandle } from "../collab/control/preset-names";
import { Refused } from "../collab/refusals";
import type { CollabContext } from "../collab/service";
import { dependencyService } from "../dependencies/registry";
import { insertLaunch, launchFor } from "../dependencies/store";
import { recordNodeCreator, requestTrigger } from "../identity/creators";
import { DomainError, badRequest } from "../workspaces/support";
import { agentDisabled, availableAgentIds, validAgentId } from "./registry";

/**
 * 会话页里新建的 Agent 会话（Armadra#1062 S2）。
 *
 * 会话就是工作空间会话板（`boards.kind = 'sessions'`）上的一个普通 Agent 终端
 * 节点：状态、审批、投递、链接文档、时间线全部沿用节点那一套，不另起语义。
 * 会话板不会在画布里打开，所以没有页面挂载节点去起进程；这里交给依赖编排去
 * 起——一条没有边的启动行（与工作流起角色节点同一条路），终端驱动与 ACP 驱动
 * 都由 `spawnForNode` 起。
 */

/** 会话板上节点的网格：坐标没有意义，只为满足 `NOT NULL` 且互不重叠。 */
const GRID_COLUMNS = 4;
const GRID_X = 560;
const GRID_Y = 400;
/** 撞上并发保存最多重来几次。 */
const SAVE_ATTEMPTS = 3;

export interface StartSessionRequest {
  readonly workspaceId: string;
  readonly agentId: string;
  /** 缺省按用户的默认视图偏好（`agents.defaultDriver`）。 */
  readonly driver?: AgentDriver | undefined;
  readonly model?: string | undefined;
  readonly title?: string | undefined;
}

export interface StartedSession {
  readonly nodeId: string;
  readonly boardId: string;
  readonly title: string;
}

function checkAgent(collab: CollabContext, agentId: string): void {
  const choices = availableAgentIds(collab.settings).join(" / ");
  if (!validAgentId(agentId)) {
    throw badRequest(`Unknown agent \`${agentId}\`; available: ${choices}`);
  }
  if (agentDisabled(collab.settings, agentId)) {
    throw new DomainError(
      403,
      "agent_disabled",
      `Agent \`${agentId}\` is disabled in settings`,
    );
  }
}

function placement(index: number): { x: number; y: number } {
  return {
    x: (index % GRID_COLUMNS) * GRID_X,
    y: Math.floor(index / GRID_COLUMNS) * GRID_Y,
  };
}

export function startPageSession(
  collab: CollabContext,
  request: StartSessionRequest,
  nowSeconds: number,
): StartedSession {
  checkAgent(collab, request.agentId);
  if (request.model !== undefined && request.model.length > 200) {
    throw badRequest("Model is too long");
  }
  const database = collab.database;
  const board = ensureSessionBoard(database, request.workspaceId);
  let view: ReturnType<typeof newNodeView>;
  try {
    view = newNodeView(collab.settings, request.agentId, {
      ...(request.driver === undefined ? {} : { surface: request.driver }),
    });
  } catch (error) {
    if (error instanceof Refused) {
      throw new DomainError(error.status, error.code, error.message);
    }
    throw error;
  }
  const agent: Record<string, unknown> = { id: request.agentId, ...view };
  if (request.model !== undefined && request.model !== "") {
    agent.model = request.model;
  }
  const trigger = requestTrigger();
  for (let attempt = 1; ; attempt += 1) {
    const document = loadBoard(database, request.workspaceId, board.id);
    const name = nameFor(
      request.title === undefined || request.title.trim() === ""
        ? undefined
        : request.title,
      document.nodes,
    );
    const node: CanvasNode = newNode(
      board.id,
      "terminal",
      name.title,
      placement(document.nodes.length),
      withHandle({ kind: "terminal", agent }, name),
    );
    recordNodeCreator(
      database,
      { nodeId: node.id, workspaceId: request.workspaceId },
      trigger,
    );
    try {
      saveBoard(database, request.workspaceId, board.id, {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: [...document.nodes, node],
        edges: document.edges,
        viewport: document.board.viewport,
      });
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.status === 409 &&
        attempt < SAVE_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
    collab.publish(request.workspaceId, {
      type: "board.changed",
      boardId: board.id,
      updatedAt: loadBoard(database, request.workspaceId, board.id).board
        .updatedAt,
    });
    if (launchFor(database, node.id) === undefined) {
      insertLaunch(
        database,
        {
          nodeId: node.id,
          workspaceId: request.workspaceId,
          boardId: board.id,
          now: nowSeconds,
        },
        [],
      );
    }
    void dependencyService()?.created(node.id);
    return { nodeId: node.id, boardId: board.id, title: name.title };
  }
}
