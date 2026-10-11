import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { install as installFiles } from "./routes";
import { releaseWorkspace } from "./watch";
import { sendFile } from "../http/server";
import { resetRouteGuard } from "../identity/gate";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";

/**
 * 本机文件整份下载是流式的（契约 §37.2，#337）：`file-download` 不带 `Range`
 * 时答 `file`，服务器边读盘边写，不把整份读进内存，也不再受 16 MiB 上限。
 */

const MIB = 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("本机文件的整份下载（HTTP）", () => {
  let core: Fixture;
  let base: string;
  let id: string;
  let root: string;
  // 比原来整份下载的 16 MiB 上限大。
  const large = Buffer.alloc(20 * MIB);
  for (let index = 0; index < large.length; index += 4096) {
    large.writeUInt32BE(index, index);
  }

  beforeAll(async () => {
    core = fixture([installWorkspaces, installFiles]);
    const listener = core.server.createListener();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    root = join(core.directory, "project");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "big.bin"), large);
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    id = (
      (
        await core.call("POST", "/api/workspaces", {
          name: "download",
          rootPath: root,
        })
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    resetRouteGuard();
    releaseWorkspace(id);
    await core.server.close();
    core.close();
  });

  const download = (path: string, init?: RequestInit) =>
    fetch(
      `${base}/api/workspaces/${id}/file-download?path=${encodeURIComponent(path)}`,
      init,
    );

  it("超过 16 MiB 的文件整份 200，长度与字节一致、附件不嗅探", async () => {
    const response = await download("big.bin");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(large.length));
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(large.length);
    expect(digest(body)).toBe(digest(large));
  });

  it("上传的 HTML 照样是附件 + octet-stream", async () => {
    const response = await download("page.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  it("空文件 200、长度 0", async () => {
    const response = await download("empty.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("带 Range 仍只读那一段（206）", async () => {
    const response = await download("big.bin", {
      headers: { range: `bytes=${8 * MIB}-${8 * MIB + 9}` },
    });
    expect(response.status).toBe(206);
    expect(
      Buffer.from(await response.arrayBuffer()).equals(
        large.subarray(8 * MIB, 8 * MIB + 10),
      ),
    ).toBe(true);
  });

  it("越界、不存在与不是文件照旧 4xx，不发流", async () => {
    for (const path of ["../outside.txt", "missing.bin"]) {
      const status = (await download(path)).status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
    mkdirSync(join(root, "dir"), { recursive: true });
    expect((await download("dir")).status).toBe(400);
  });

  it("进程内调用路由表（测试夹具）照旧从 raw 读到字节", async () => {
    const answer = await core.call(
      "GET",
      `/api/workspaces/${id}/file-download?path=big.bin`,
    );
    expect(answer.status).toBe(200);
    expect(answer.raw?.length).toBe(large.length);
    expect(digest(answer.raw ?? Buffer.alloc(0))).toBe(digest(large));
  });
});

describe("sendFile", () => {
  async function serve(
    file: { absolute: string; size: number },
    method = "GET",
  ): Promise<Response> {
    const server = createServer((_request, response) => {
      sendFile(response, 200, { "x-test": "1" }, file);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    try {
      return await fetch(`http://127.0.0.1:${port}/`, { method });
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  const directory = fixture([]);
  afterAll(() => directory.close());
  const path = join(directory.directory, "short.bin");
  writeFileSync(path, Buffer.alloc(1000, 7));

  it("文件比头里说的短（途中被截断）：断开，客户端拿不到一份「成功」的截断文件", async () => {
    const response = await serve({ absolute: path, size: 5000 });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("读盘失败（文件没了）：断开", async () => {
    await expect(
      serve({
        absolute: join(directory.directory, "missing.bin"),
        size: 10,
      }).then((response) => response.arrayBuffer()),
    ).rejects.toThrow();
  });

  it("HEAD 只给头", async () => {
    const response = await serve({ absolute: path, size: 1000 }, "HEAD");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("x-test")).toBe("1");
  });
});
