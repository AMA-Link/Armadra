/**
 * 时间线的 blob（设计 §3.2）：图片、音频与内嵌资源的字节。
 *
 * 字节按内容寻址放在 `<数据目录>/timeline/blobs/<sha256>`（0600），条目和事件里只有
 * `{ blobId, mimeType, bytes }`；`timeline_blobs` 记「哪条时间线引用了哪个 blob」，
 * 读的时候以它为准——知道 blobId 不等于能读，必须是这条时间线自己的 blob。单个超过
 * 8 MiB 的不存（条目记 `dropped`）。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** 单个 blob 的上限（设计 §3.2）。 */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

const BLOB_ID = /^[0-9a-f]{64}$/;

export interface StoredBlob {
  readonly blobId: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export class BlobStore {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly database: DatabaseSync,
  ) {
    this.dir = join(dataDir, "timeline", "blobs");
  }

  /**
   * 存一个 base64 的 blob 并登记到这条时间线；超限、不是合法 base64 或写盘失败
   * 答 `null`（调用方把部件记为 `dropped`）。同一内容重复存是幂等的。
   */
  store(
    timelineId: string,
    mimeType: string,
    base64: string,
  ): StoredBlob | null {
    // base64 解出来的字节数不会超过它的 3/4；先按长度挡掉明显超限的，免得解码。
    if (base64.length > Math.ceil((MAX_BLOB_BYTES * 4) / 3) + 4) return null;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_BLOB_BYTES) return null;
    const blobId = createHash("sha256").update(bytes).digest("hex");
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const target = join(this.dir, blobId);
      if (!existsSync(target)) {
        const partial = `${target}.${process.pid}.tmp`;
        writeFileSync(partial, bytes, { mode: 0o600 });
        renameSync(partial, target);
      }
      this.database
        .prepare(
          "INSERT INTO timeline_blobs(timeline_id, blob_id, mime_type, bytes) VALUES(?, ?, ?, ?) " +
            "ON CONFLICT(timeline_id, blob_id) DO NOTHING",
        )
        .run(timelineId, blobId, mimeType.slice(0, 200), bytes.length);
    } catch {
      return null;
    }
    return { blobId, bytes: bytes.length, mimeType };
  }

  /** 这条时间线引用的 blob；不是它的、没登记的、文件没了的都答 `undefined`。 */
  read(
    timelineId: string,
    blobId: string,
  ): { readonly mimeType: string; readonly data: Buffer } | undefined {
    if (!BLOB_ID.test(blobId)) return undefined;
    const row = this.database
      .prepare(
        "SELECT mime_type FROM timeline_blobs WHERE timeline_id = ? AND blob_id = ?",
      )
      .get(timelineId, blobId) as { mime_type: string } | undefined;
    if (row === undefined) return undefined;
    try {
      return {
        mimeType: row.mime_type,
        data: readFileSync(join(this.dir, blobId)),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 回收没有任何时间线引用的字节文件（时间线被删之后调）。`candidates` 是刚被删的
   * 那条时间线引用过的 blob id；仍被别的时间线引用的留着。
   */
  collect(candidates: readonly string[]): number {
    let removed = 0;
    const referenced = this.database.prepare(
      "SELECT 1 FROM timeline_blobs WHERE blob_id = ? LIMIT 1",
    );
    for (const blobId of candidates) {
      if (!BLOB_ID.test(blobId) || referenced.get(blobId) !== undefined) {
        continue;
      }
      try {
        rmSync(join(this.dir, blobId), { force: true });
        removed++;
      } catch {
        // 下一次清理再试。
      }
    }
    return removed;
  }

  /** 一条时间线引用的全部 blob id（删它之前取，好在删后回收文件）。 */
  idsOf(timelineId: string): string[] {
    const rows = this.database
      .prepare("SELECT blob_id FROM timeline_blobs WHERE timeline_id = ?")
      .all(timelineId) as { blob_id: string }[];
    return rows.map((row) => row.blob_id);
  }
}
