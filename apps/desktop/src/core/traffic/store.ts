/**
 * `traffic_buckets`（迁移 0049，契约 §76）的读写。
 *
 * 写只有一种：一批行在一个事务里 upsert，冲突时把数加上去——同一桶在两次 flush
 * 之间、或进程重启前后各写一部分，结果都等于一次写完。
 */

import type { DatabaseSync } from "node:sqlite";

import type { TrafficCategory, TrafficPeerKind } from "@armadra/shared";

import type { TrafficBucketRow, TrafficRoute } from "./meter";

const DAY_MS = 86_400_000;

export interface StoredBucket {
  readonly bucketStartMs: number;
  readonly route: TrafficRoute;
  readonly issuer: string;
  readonly peerKind: TrafficPeerKind;
  readonly peerId: string;
  readonly principalId: string;
  readonly linkId: string;
  readonly category: TrafficCategory;
  readonly streams: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export interface BucketFilter {
  readonly fromMs: number;
  readonly toMs: number;
  readonly peerId?: string;
  readonly linkId?: string;
  readonly category?: TrafficCategory;
}

export class TrafficStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 一批行，一个事务。全是零的行不写。 */
  upsert(rows: readonly TrafficBucketRow[]): void {
    const live = rows.filter(
      (row) => row.streams > 0 || row.bytesIn > 0 || row.bytesOut > 0,
    );
    if (live.length === 0) return;
    const statement = this.database.prepare(
      "INSERT INTO traffic_buckets(bucket_start_ms, route, issuer, peer_kind, peer_id, principal_id, link_id, " +
        "category, streams, bytes_in, bytes_out) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(bucket_start_ms, route, issuer, peer_kind, peer_id, principal_id, link_id, category) " +
        "DO UPDATE SET streams = streams + excluded.streams, bytes_in = bytes_in + excluded.bytes_in, " +
        "bytes_out = bytes_out + excluded.bytes_out",
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of live) {
        statement.run(
          row.bucketStartMs,
          row.route,
          row.issuer,
          row.peerKind,
          row.peerId,
          row.principalId,
          row.linkId,
          row.category,
          row.streams,
          row.bytesIn,
          row.bytesOut,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** `[fromMs, toMs)` 里与过滤条件相符的全部桶，按时间升序。 */
  buckets(filter: BucketFilter): StoredBucket[] {
    const where = ["bucket_start_ms >= ?", "bucket_start_ms < ?"];
    const params: (string | number)[] = [filter.fromMs, filter.toMs];
    if (filter.peerId !== undefined) {
      where.push("peer_id = ?");
      params.push(filter.peerId);
    }
    if (filter.linkId !== undefined) {
      where.push("link_id = ?");
      params.push(filter.linkId);
    }
    if (filter.category !== undefined) {
      where.push("category = ?");
      params.push(filter.category);
    }
    const rows = this.database
      .prepare(
        "SELECT bucket_start_ms, route, issuer, peer_kind, peer_id, principal_id, link_id, category, " +
          `streams, bytes_in, bytes_out FROM traffic_buckets WHERE ${where.join(" AND ")} ` +
          "ORDER BY bucket_start_ms",
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      bucketStartMs: Number(row.bucket_start_ms),
      route: String(row.route) as TrafficRoute,
      issuer: String(row.issuer),
      peerKind: String(row.peer_kind) as TrafficPeerKind,
      peerId: String(row.peer_id),
      principalId: String(row.principal_id),
      linkId: String(row.link_id),
      category: String(row.category) as TrafficCategory,
      streams: Number(row.streams),
      bytesIn: Number(row.bytes_in),
      bytesOut: Number(row.bytes_out),
    }));
  }

  /** 删掉保留期之前的桶；答删了几行。 */
  prune(nowMs: number, retentionDays: number): number {
    const cutoff = nowMs - retentionDays * DAY_MS;
    const result = this.database
      .prepare("DELETE FROM traffic_buckets WHERE bucket_start_ms < ?")
      .run(cutoff);
    return Number(result.changes);
  }

  clear(): void {
    this.database.exec("DELETE FROM traffic_buckets");
  }
}
