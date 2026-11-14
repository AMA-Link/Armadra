/**
 * `forge_workspace_remote`（迁移 0066）：用户为某个工作空间选的主 remote。
 * 存的是 remote 的名字；没有行 = 按默认顺序。
 */

import type { DatabaseSync } from "node:sqlite";

export class RemoteSelectionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(workspaceId: string): string | null {
    const row = this.database
      .prepare(
        "SELECT remote FROM forge_workspace_remote WHERE workspace_id = ?",
      )
      .get(workspaceId) as { remote: string } | undefined;
    return row?.remote ?? null;
  }

  /** `null` 清掉选择。 */
  set(workspaceId: string, remote: string | null): void {
    if (remote === null) {
      this.database
        .prepare("DELETE FROM forge_workspace_remote WHERE workspace_id = ?")
        .run(workspaceId);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO forge_workspace_remote (workspace_id, remote, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           remote = excluded.remote, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(workspaceId, remote, this.now());
  }
}
