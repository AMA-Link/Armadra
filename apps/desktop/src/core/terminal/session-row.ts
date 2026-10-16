import type { DatabaseSync } from "node:sqlite";

import type { BackendKind, SessionKey } from "./backend";

/** What `spawn` records about a session the moment its process is up. */
export interface SessionRowInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly command: string | null;
  readonly kind: string;
  readonly ownerNodeId: string | null;
  readonly agentId: string | null;
  readonly createdAt: string;
  readonly key: SessionKey;
  readonly backendKind: BackendKind;
  readonly backendRef: string | null;
  readonly generation: number;
}

export function insertSessionRow(
  database: DatabaseSync,
  row: SessionRowInput,
): void {
  database
    .prepare(
      `INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind,
         owner_node_id, agent_id, status, created_at, session_key, backend_kind,
         backend_ref, generation, attach_state, termination_intent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 'detached', 'none')`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.cwd,
      row.shell,
      row.command,
      row.kind,
      row.ownerNodeId,
      row.agentId,
      row.createdAt,
      row.key,
      row.backendKind,
      row.backendRef,
      row.generation,
    );
}
