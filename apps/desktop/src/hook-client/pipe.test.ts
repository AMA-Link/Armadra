/**
 * The hook client's pipe transport (contract §102.5). The pipe path is a Unix
 * socket here so the same cases run on every platform; the client treats both
 * as a path behind the `armadra-pipe/1` handshake.
 */

import { randomBytes } from "node:crypto";
import { createServer as httpServer } from "node:http";
import * as net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { channelKey } from "../core/private-pipe/handshake";
import { HOOK_LABEL } from "../core/private-pipe/labels";
import { guardServer } from "../core/private-pipe/server";
import { discoverCandidatesFrom, loadEndpoint } from "./endpoint.js";
import { hookFixture } from "../core/hook/fixture";
import { getRequest, postJsonRequest, send } from "./http.js";

function socketPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\armadra-hook-test-${process.pid}-${randomBytes(4).toString("hex")}`
    : join(mkdtempSync(join(tmpdir(), "armadra-hp-")), "h.sock");
}

const request = postJsonRequest(
  "/hook/claude",
  [["X-Armadra-Hook-Token", "bearer"]],
  Buffer.from('{"a":1}'),
);

async function guarded(bearer: string) {
  const path = socketPath();
  const bodies: string[] = [];
  const server = httpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(parts).toString("utf8"));
      res.writeHead(204);
      res.end();
    });
  });
  guardServer(server, {
    channel: {
      label: HOOK_LABEL,
      pipe: path,
      key: channelKey(bearer, HOOK_LABEL),
    },
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  server.unref();
  return { path, bodies, close: () => server.close() };
}

describe("the pipe transport", () => {
  it("delivers a report after the handshake", async () => {
    const served = await guarded("a-bearer-token-0123456789");
    try {
      const outcome = await send(
        {
          path: "-",
          pipe: served.path,
          hookToken: "a-bearer-token-0123456789",
        },
        request,
      );
      expect(outcome).toHaveProperty("ok");
      expect((outcome as { ok: { status: number } }).ok.status).toBe(204);
      expect(served.bodies).toEqual(['{"a":1}']);
    } finally {
      served.close();
    }
  });

  it("does not send the report to a server that cannot prove the bearer", async () => {
    // The squatter: a server that was never given the key.
    const served = await guarded("someone-elses-bearer-0123456");
    try {
      const outcome = await send(
        {
          path: "-",
          pipe: served.path,
          hookToken: "a-bearer-token-0123456789",
        },
        request,
      );
      expect(outcome).toHaveProperty("error");
      // Nothing was sent, so a fallback transport may still run the report.
      expect((outcome as { sent?: boolean }).sent).not.toBe(true);
      expect(served.bodies).toEqual([]);
    } finally {
      served.close();
    }
  });

  it("a plain server on the pipe name receives only the client nonce", async () => {
    const path = socketPath();
    const received: Buffer[] = [];
    const squatter = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk);
        socket.write(randomBytes(48));
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => squatter.listen(path, resolve));
    squatter.unref();
    try {
      const outcome = await send(
        { path: "-", pipe: path, hookToken: "a-bearer-token-0123456789" },
        request,
      );
      expect(outcome).toHaveProperty("error");
      expect(Buffer.concat(received).length).toBe(20);
    } finally {
      squatter.close();
    }
  });

  it("falls back to the port when the pipe cannot prove itself", async () => {
    const squatterPath = socketPath();
    const squatter = net.createServer((socket) => {
      socket.on("data", () => socket.write(randomBytes(48)));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) =>
      squatter.listen(squatterPath, resolve),
    );
    squatter.unref();
    const web = httpServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    web.unref();
    try {
      const outcome = await send(
        {
          path: "-",
          pipe: squatterPath,
          port: (web.address() as net.AddressInfo).port,
          hookToken: "a-bearer-token-0123456789",
        },
        request,
      );
      expect(outcome).toHaveProperty("ok");
    } finally {
      squatter.close();
      web.close();
    }
  });

  it("needs the bearer to even try the pipe", async () => {
    const outcome = await send({ path: "-", pipe: socketPath() }, request);
    expect(outcome).toHaveProperty("error");
  });
});

describe("the endpoint file's pipe", () => {
  it("is read from ARMADRA_HOOK_PIPE and counts as a transport", () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-hp-"));
    const file = join(dir, "hook-endpoint.env");
    writeFileSync(
      file,
      [
        "ARMADRA_HOOK_VERSION='1'",
        "ARMADRA_HOOK_PIPE='\\\\.\\pipe\\armadra-hook-0011'",
        "ARMADRA_HOOK_TOKEN='tok'",
        "ARMADRA_NODE_TOKEN_DIR='/x'",
      ].join("\n"),
    );
    const loaded = loadEndpoint(file);
    expect("ok" in loaded && loaded.ok.pipe).toBe(
      "\\\\.\\pipe\\armadra-hook-0011",
    );
    expect(discoverCandidatesFrom(file, undefined)[0]?.pipe).toBe(
      "\\\\.\\pipe\\armadra-hook-0011",
    );
  });
});

/** Windows runner only: the hook server on a real named pipe, reached by the client. */
describe.skipIf(process.platform !== "win32")("a real hook pipe", () => {
  it("serves /verify to a client that completes the handshake", async () => {
    const one = hookFixture();
    const name = `armadra-hook-test-${process.pid}`;
    try {
      await one.server.listen(
        { kind: "pipe", name },
        {
          channel: {
            label: HOOK_LABEL,
            key: channelKey(one.bearer, HOOK_LABEL),
          },
          harden: async () => ({ ok: false, reason: "test" }),
        },
      );
      const outcome = await send(
        { path: "-", pipe: `\\\\.\\pipe\\${name}`, hookToken: one.bearer },
        getRequest("/verify", [["X-Armadra-Hook-Token", one.bearer]]),
      );
      expect(outcome).toHaveProperty("ok");
      expect((outcome as { ok: { status: number } }).ok.status).toBe(204);
    } finally {
      await one.server.close();
      one.close();
    }
  });
});
