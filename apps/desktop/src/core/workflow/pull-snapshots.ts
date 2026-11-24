import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { PullSnapshot } from "@armadra/shared";
import type { ForgePullSnapshot } from "../forge/types";

/**
 * PR 快照的存储（契约 §115，#988）。一个 PR 一行；只存平台读到的状态字段，不存
 * 正文与评论。`stale` 读时算：超过 {@link SNAPSHOT_STALE_MS} 没刷新，或最近一次
 * 刷新失败了（比上次成功还新）。
 */

export const SNAPSHOT_STALE_MS = 10 * 60_000;

/** 键排序的 JSON：同样的内容永远得同一个串，与平台实现里的键顺序无关。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 快照本身就不含读取时刻，所以稳定串就是指纹。 */
function fingerprintOf(snapshot: ForgePullSnapshot): string {
  return createHash("sha256").update(stable(snapshot)).digest("hex");
}

/** 记一份快照。答指纹变没变（第一次记也算变）；没变只刷新读取时刻并清掉失败标记。 */
export function saveSnapshot(
  database: DatabaseSync,
  repo: string,
  snapshot: ForgePullSnapshot,
  nowMs: number,
): boolean {
  const fingerprint = fingerprintOf(snapshot);
  const row = database
    .prepare(
      "SELECT fingerprint FROM pull_snapshots WHERE repo = ? AND number = ?",
    )
    .get(repo, snapshot.number) as { fingerprint: string } | undefined;
  if (row?.fingerprint === fingerprint) {
    database
      .prepare(
        "UPDATE pull_snapshots SET fetched_at = ?, failed_at = NULL WHERE repo = ? AND number = ?",
      )
      .run(nowMs, repo, snapshot.number);
    return false;
  }
  database
    .prepare(
      "INSERT INTO pull_snapshots (repo, number, snapshot_json, fingerprint, fetched_at, failed_at) " +
        "VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(repo, number) DO UPDATE SET " +
        "snapshot_json = excluded.snapshot_json, fingerprint = excluded.fingerprint, " +
        "fetched_at = excluded.fetched_at, failed_at = NULL",
    )
    .run(repo, snapshot.number, JSON.stringify(snapshot), fingerprint, nowMs);
  return true;
}

/** 这次读取失败了；没有这一行就什么也不做（没有旧快照可标）。 */
export function markSnapshotFailed(
  database: DatabaseSync,
  repo: string,
  number: number,
  nowMs: number,
): void {
  database
    .prepare(
      "UPDATE pull_snapshots SET failed_at = ? WHERE repo = ? AND number = ?",
    )
    .run(nowMs, repo, number);
}

/** 读一批快照，按给定顺序；没有记过的跳过。 */
export function loadSnapshots(
  database: DatabaseSync,
  keys: readonly { readonly repo: string; readonly number: number }[],
  nowMs: number,
): PullSnapshot[] {
  const select = database.prepare(
    "SELECT snapshot_json, fetched_at, failed_at FROM pull_snapshots WHERE repo = ? AND number = ?",
  );
  const found: PullSnapshot[] = [];
  for (const key of keys) {
    const row = select.get(key.repo, key.number) as
      | {
          snapshot_json: string;
          fetched_at: number;
          failed_at: number | null;
        }
      | undefined;
    if (row === undefined) continue;
    const fetchedAt = Number(row.fetched_at);
    const failedAt = row.failed_at === null ? 0 : Number(row.failed_at);
    found.push({
      ...(JSON.parse(row.snapshot_json) as ForgePullSnapshot),
      repo: key.repo,
      fetchedAtMs: fetchedAt,
      stale: nowMs - fetchedAt > SNAPSHOT_STALE_MS || failedAt > fetchedAt,
    });
  }
  return found;
}

/** 这个 PR 上次成功读取的时刻；没记过是 `undefined`。 */
export function snapshotFetchedAt(
  database: DatabaseSync,
  repo: string,
  number: number,
): number | undefined {
  const row = database
    .prepare(
      "SELECT fetched_at FROM pull_snapshots WHERE repo = ? AND number = ?",
    )
    .get(repo, number) as { fetched_at: number } | undefined;
  return row === undefined ? undefined : Number(row.fetched_at);
}
