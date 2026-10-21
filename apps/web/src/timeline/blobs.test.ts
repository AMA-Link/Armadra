import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sources = vi.hoisted(() => ({
  fetch: vi.fn(),
}));
vi.mock("@/api/source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/source")>()),
  sourceById: () => ({ httpBase: "http://core", fetch: sources.fetch }),
}));

import { setTimelineTransportFactory } from "./api";
import {
  blobFromBase64,
  createBlobLoader,
  putLocalBlob,
  resetBlobs,
} from "./blobs";
import { FakeCore } from "./test-support";

const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

beforeEach(() => {
  resetBlobs();
  sources.fetch.mockReset();
});
afterEach(() => setTimelineTransportFactory());

describe("blob loading", () => {
  it("reads page-local blobs from memory, never the network", async () => {
    const id = putLocalBlob(png);
    expect(id.startsWith("local:")).toBe(true);
    const loaded = await createBlobLoader("local", "s1")(id);
    expect(loaded).toBe(png);
    expect(sources.fetch).not.toHaveBeenCalled();
  });

  it("streams a core blob over the HTTP path and keeps it", async () => {
    sources.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const load = createBlobLoader("local", "s 1");
    const first = await load("abc");
    expect(first.size).toBe(3);
    expect(sources.fetch).toHaveBeenCalledWith(
      "http://core/api/timelines/s%201/blobs/abc",
      expect.anything(),
    );
    await load("abc");
    expect(sources.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to timeline.blob when the HTTP path cannot be read", async () => {
    sources.fetch.mockResolvedValue(new Response("no", { status: 502 }));
    const core = new FakeCore();
    core.transport.blob = vi.fn(async () => ({
      mimeType: "image/png",
      bytes: 3,
      data: btoa("\u0001\u0002\u0003"),
    }));
    setTimelineTransportFactory(() => core.transport);
    const loaded = await createBlobLoader("local", "s1")("abc");
    expect(loaded.type).toBe("image/png");
    expect(loaded.size).toBe(3);
    expect(core.transport.blob).toHaveBeenCalledWith("s1", "abc");
  });

  it("does not remember a failure", async () => {
    sources.fetch.mockRejectedValue(new TypeError("offline"));
    const core = new FakeCore();
    core.transport.blob = vi.fn(async () => {
      throw new Error("down");
    });
    setTimelineTransportFactory(() => core.transport);
    const load = createBlobLoader("local", "s1");
    await expect(load("abc")).rejects.toThrow("down");
    sources.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(load("abc")).resolves.toBeInstanceOf(Blob);
  });

  it("decodes base64 into a typed blob", async () => {
    const blob = blobFromBase64(btoa("hi"), "text/plain");
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("hi");
  });
});
