import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "../testing/temp-dir";
import { BlobStore, MAX_BLOB_BYTES } from "./blobs";
import { TimelineStore } from "./store";
import { memoryDatabase } from "./testing";

let database: DatabaseSync;
let blobs: BlobStore;
let dir: string;

beforeEach(() => {
  dir = tempDir("timeline-blobs-");
  database = memoryDatabase();
  const store = new TimelineStore(database);
  store.ensure({ id: "s1", workspaceId: "w", nodeId: "n" }, 1);
  store.ensure({ id: "s2", workspaceId: "w", nodeId: "n2" }, 1);
  blobs = new BlobStore(dir, database);
});

afterEach(() => {
  database.close();
});

const png = Buffer.from("89504e470d0a1a0a00", "hex");

describe("BlobStore", () => {
  it("内容寻址存盘，登记到时间线，读回字节与类型", () => {
    const stored = blobs.store("s1", "image/png", png.toString("base64"));
    expect(stored).toEqual({
      blobId: createHash("sha256").update(png).digest("hex"),
      bytes: png.length,
      mimeType: "image/png",
    });
    const read = blobs.read("s1", stored!.blobId);
    expect(read?.mimeType).toBe("image/png");
    expect(read?.data.equals(png)).toBe(true);
    const file = join(dir, "timeline", "blobs", stored!.blobId);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("同一内容重复存是幂等的，不同时间线各自登记", () => {
    const a = blobs.store("s1", "image/png", png.toString("base64"))!;
    const again = blobs.store("s1", "image/png", png.toString("base64"))!;
    const other = blobs.store("s2", "image/png", png.toString("base64"))!;
    expect(again.blobId).toBe(a.blobId);
    expect(other.blobId).toBe(a.blobId);
    expect(readdirSync(join(dir, "timeline", "blobs"))).toHaveLength(1);
    expect(blobs.idsOf("s1")).toEqual([a.blobId]);
  });

  it("读只认这条时间线自己的 blob：知道 blobId 不等于能读", () => {
    const stored = blobs.store("s1", "image/png", png.toString("base64"))!;
    expect(blobs.read("s2", stored.blobId)).toBeUndefined();
    expect(blobs.read("s1", "../../etc/passwd")).toBeUndefined();
    expect(blobs.read("s1", "0".repeat(64))).toBeUndefined();
  });

  it("超过 8 MiB、空内容不存（部件记 dropped）", () => {
    const big = Buffer.alloc(MAX_BLOB_BYTES + 1, 1).toString("base64");
    expect(blobs.store("s1", "image/png", big)).toBeNull();
    expect(blobs.store("s1", "image/png", "")).toBeNull();
    const edge = Buffer.alloc(MAX_BLOB_BYTES, 2).toString("base64");
    expect(blobs.store("s1", "image/png", edge)?.bytes).toBe(MAX_BLOB_BYTES);
  });

  it("collect 只回收没有任何时间线引用的文件", () => {
    const a = blobs.store("s1", "image/png", png.toString("base64"))!;
    const only = blobs.store(
      "s1",
      "audio/wav",
      Buffer.from("only-s1").toString("base64"),
    )!;
    blobs.store("s2", "image/png", png.toString("base64"));
    database.prepare("DELETE FROM timelines WHERE id = 's1'").run();
    expect(blobs.collect([a.blobId, only.blobId])).toBe(1);
    const root = join(dir, "timeline", "blobs");
    expect(existsSync(join(root, a.blobId))).toBe(true);
    expect(existsSync(join(root, only.blobId))).toBe(false);
  });
});
