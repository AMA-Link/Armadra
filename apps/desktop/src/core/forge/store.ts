/**
 * `forge_config`（迁移 0038，整台机器）与 `forge_workspace_config`（迁移 0048，
 * 某个工作空间，契约 §75）的读写。两张表列相同；`workspaceId` 为 `""` 时读写整机
 * 那张。令牌不在这里，只有它在 SecretStore 里的名字。
 */

import type { DatabaseSync } from "node:sqlite";

import { type ForgeKind, forgeError } from "./types";

export interface ForgeConfigRecord {
  /** `""` = 整台机器的一行。 */
  readonly workspaceId: string;
  readonly repoKey: string;
  readonly forge: ForgeKind;
  readonly apiBase: string;
  readonly credentialRef: string;
  readonly accountLogin: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface Row {
  repo_key: string;
  forge: ForgeKind;
  api_base: string;
  credential_ref: string;
  account_login: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}

const COLUMNS =
  "repo_key, forge, api_base, credential_ref, account_login, revision, created_at_ms, updated_at_ms";

function record(row: Row, workspaceId: string): ForgeConfigRecord {
  return {
    workspaceId,
    repoKey: row.repo_key,
    forge: row.forge,
    apiBase: row.api_base,
    credentialRef: row.credential_ref,
    accountLogin: row.account_login,
    revision: Number(row.revision),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export interface PutConfig {
  /** `""` = 整台机器。 */
  readonly workspaceId?: string;
  readonly repoKey: string;
  readonly forge: ForgeKind;
  readonly apiBase: string;
  readonly credentialRef: string;
  readonly accountLogin: string;
  /** 0 = 新建；其他值必须等于存着的 revision。 */
  readonly expectedRevision: number;
  readonly atMs: number;
}

/** 一张表与它在 `WHERE` 里多出的那一段。 */
function table(workspaceId: string): {
  name: string;
  scope: string;
  params: string[];
} {
  return workspaceId === ""
    ? { name: "forge_config", scope: "", params: [] }
    : {
        name: "forge_workspace_config",
        scope: " AND workspace_id = ?",
        params: [workspaceId],
      };
}

export class ForgeStore {
  constructor(private readonly database: DatabaseSync) {}

  get(repoKey: string, workspaceId = ""): ForgeConfigRecord | undefined {
    const { name, scope, params } = table(workspaceId);
    const row = this.database
      .prepare(`SELECT ${COLUMNS} FROM ${name} WHERE repo_key = ?${scope}`)
      .get(repoKey, ...params) as Row | undefined;
    return row === undefined ? undefined : record(row, workspaceId);
  }

  list(workspaceId = ""): ForgeConfigRecord[] {
    const { name, scope, params } = table(workspaceId);
    const rows = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM ${name} WHERE 1 = 1${scope} ORDER BY repo_key`,
      )
      .all(...params) as unknown as Row[];
    return rows.map((row) => record(row, workspaceId));
  }

  /** 按 revision CAS 写一行；对不上抛 `conflict`，工作空间不存在抛 `notFound`。 */
  put(input: PutConfig): ForgeConfigRecord {
    const workspaceId = input.workspaceId ?? "";
    const { name, scope, params } = table(workspaceId);
    const current = this.get(input.repoKey, workspaceId);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw forgeError("conflict", "REVISION_MISMATCH");
    }
    if (current === undefined) {
      try {
        this.database
          .prepare(
            workspaceId === ""
              ? `INSERT INTO ${name} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
              : `INSERT INTO ${name} (workspace_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            ...params,
            input.repoKey,
            input.forge,
            input.apiBase,
            input.credentialRef,
            input.accountLogin,
            input.atMs,
            input.atMs,
          );
      } catch (error) {
        // 外键：这个工作空间不在了（或从来没有）。
        if (workspaceId !== "" && /FOREIGN KEY/i.test(String(error))) {
          throw forgeError("notFound", "NO_WORKSPACE");
        }
        throw error;
      }
    } else {
      const changed = this.database
        .prepare(
          `UPDATE ${name} SET forge = ?, api_base = ?, credential_ref = ?, account_login = ?, revision = revision + 1, updated_at_ms = ? WHERE repo_key = ?${scope} AND revision = ?`,
        )
        .run(
          input.forge,
          input.apiBase,
          input.credentialRef,
          input.accountLogin,
          Math.max(input.atMs, current.createdAtMs),
          input.repoKey,
          ...params,
          input.expectedRevision,
        );
      if (Number(changed.changes) !== 1) {
        throw forgeError("conflict", "REVISION_MISMATCH");
      }
    }
    return this.get(input.repoKey, workspaceId) as ForgeConfigRecord;
  }

  /** 删一行；revision 对不上抛 `conflict`，没有这一行抛 `notFound`。 */
  delete(
    repoKey: string,
    expectedRevision: number,
    workspaceId = "",
  ): ForgeConfigRecord {
    const { name, scope, params } = table(workspaceId);
    const current = this.get(repoKey, workspaceId);
    if (current === undefined) throw forgeError("notFound", "NO_CONFIG");
    if (current.revision !== expectedRevision) {
      throw forgeError("conflict", "REVISION_MISMATCH");
    }
    this.database
      .prepare(
        `DELETE FROM ${name} WHERE repo_key = ?${scope} AND revision = ?`,
      )
      .run(repoKey, ...params, expectedRevision);
    return current;
  }
}
