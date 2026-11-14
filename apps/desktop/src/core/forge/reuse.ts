/**
 * 「复用本机登录」开关（契约 §111.6）：迁移 0067 的单例行，缺省按壳。
 */

import type { DatabaseSync } from "node:sqlite";

/** 缺省：桌面壳开；服务器壳关，设 `ARMADRA_FORGE_REUSE_LOGINS=1` 才开。 */
export function reuseDefault(
  shell: "desktop" | "server" | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (shell !== "server") return true;
  return /^(1|true|yes|on)$/i.test(
    (env.ARMADRA_FORGE_REUSE_LOGINS ?? "").trim(),
  );
}

export class ReuseSwitch {
  constructor(
    private readonly database: DatabaseSync,
    private readonly fallback: boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(): boolean {
    const row = this.database
      .prepare(
        "SELECT enabled FROM forge_reuse_local_logins WHERE singleton = 1",
      )
      .get() as { enabled: number } | undefined;
    return row === undefined ? this.fallback : row.enabled === 1;
  }

  set(enabled: boolean): void {
    this.database
      .prepare(
        `INSERT INTO forge_reuse_local_logins (singleton, enabled, updated_at_ms)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(enabled ? 1 : 0, this.now());
  }
}
