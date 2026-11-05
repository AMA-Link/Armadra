import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { type IncomingMessage, Agent, createServer, request } from "node:http";
import { type Socket, createServer as netServer, connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ListenSpec, bind, release } from "../listen";
import { tempDir } from "../testing/temp-dir";
import {
  type Channel,
  CLIENT_HELLO_BYTES,
  ClientHandshake,
  SERVER_REPLY_BYTES,
  ServerHandshake,
  channelKey,
  connectPrivate,
  ensurePipeKey,
  guardServer,
  normalizePipe,
  pipeKeyPath,
  proof,
  readPipeKey,
} from "./index";
import { pipeAclSummary } from "./state";

const root = Buffer.alloc(32, 7);
const channel = (
  label = "runtime",
  key = channelKey(root, label),
): Channel => ({
  label,
  pipe: "armadra-test",
  key,
});

/** Runs both sides of a handshake in memory, returning each side's last step. */
function converse(server: Channel, client: Channel) {
  const s = new ServerHandshake(server, Buffer.alloc(16, 2));
  const c = new ClientHandshake(client, Buffer.alloc(16, 1));
  const hello = c.hello();
  const sent = s.push(hello);
  if (sent.kind !== "send") return { server: sent, client: undefined };
  const proven = c.push(sent.data);
  if (proven.kind !== "proven") return { server: sent, client: proven };
  return { server: s.push(proven.data), client: proven };
}

describe("armadra-pipe/1 vectors", () => {
  it("has fixed sizes and a stable proof for fixed nonces", () => {
    expect(CLIENT_HELLO_BYTES).toBe(20);
    expect(SERVER_REPLY_BYTES).toBe(48);
    const key = channelKey(Buffer.alloc(32, 7), "runtime");
    const a = proof(
      key,
      "server",
      "runtime",
      "\\\\.\\pipe\\Armadra-Test",
      Buffer.alloc(16, 1),
      Buffer.alloc(16, 2),
    );
    const b = proof(
      key,
      "server",
      "runtime",
      "armadra-test",
      Buffer.alloc(16, 1),
      Buffer.alloc(16, 2),
    );
    // The pipe name is normalised: prefix and case do not matter.
    expect(a.equals(b)).toBe(true);
    expect(a.toString("hex")).toMatchInlineSnapshot(
      `"b43383c5df8e39eb7793c3beaa0bb55635fdd838df457b2259e76f4203896164"`,
    );
    expect(normalizePipe("\\\\.\\pipe\\Foo")).toBe("foo");
  });

  it("accepts a matching pair", () => {
    const result = converse(channel(), channel());
    expect(result.client?.kind).toBe("proven");
    expect(result.server).toMatchObject({ kind: "accepted" });
  });

  it("rejects a different key, label or pipe on either side", () => {
    const other = channelKey(randomBytes(32), "runtime");
    // Server holds another key: the client rejects the server proof.
    expect(converse(channel("runtime", other), channel()).client).toMatchObject(
      {
        kind: "rejected",
        reason: "bad server proof",
      },
    );
    // A proof for another channel label is worthless here.
    expect(
      converse(
        channel("control"),
        channel("runtime", channelKey(root, "control")),
      ).client,
    ).toMatchObject({ kind: "rejected" });
    expect(
      converse({ ...channel(), pipe: "other" }, channel()).client,
    ).toMatchObject({ kind: "rejected" });
  });

  it("makes the server reject a client that did not hold the key", () => {
    const s = new ServerHandshake(channel());
    expect(
      s.push(Buffer.concat([Buffer.from("APH1"), randomBytes(16)])).kind,
    ).toBe("send");
    expect(s.push(randomBytes(32))).toMatchObject({
      kind: "rejected",
      reason: "bad client proof",
    });
  });

  it("rejects a bad hello and data sent before the server proof", () => {
    expect(
      new ServerHandshake(channel()).push(Buffer.alloc(20, 1)),
    ).toMatchObject({ kind: "rejected" });
    const s = new ServerHandshake(channel());
    expect(
      s.push(
        Buffer.concat([
          Buffer.from("APH1"),
          randomBytes(16),
          Buffer.from("GET /"),
        ]),
      ).kind,
    ).toBe("rejected");
  });

  it("accumulates byte by byte and returns what followed the proof", () => {
    const s = new ServerHandshake(channel(), Buffer.alloc(16, 2));
    const c = new ClientHandshake(channel(), Buffer.alloc(16, 1));
    const hello = c.hello();
    let reply: Buffer | undefined;
    for (const byte of hello) {
      const step = s.push(Buffer.from([byte]));
      if (step.kind === "send") reply = step.data;
    }
    const proven = c.push(reply as Buffer);
    expect(proven.kind).toBe("proven");
    if (proven.kind !== "proven") return;
    const tail = Buffer.from("GET / HTTP/1.1\r\n\r\n");
    expect(s.push(Buffer.concat([proven.data, tail]))).toEqual({
      kind: "accepted",
      rest: tail,
    });
  });

  it("each nonce is fresh: two runs never produce the same server proof", () => {
    const one = new ServerHandshake(channel());
    const two = new ServerHandshake(channel());
    const hello = new ClientHandshake(channel(), Buffer.alloc(16, 1)).hello();
    const a = one.push(hello);
    const b = two.push(hello);
    expect(
      a.kind === "send" && b.kind === "send" && !a.data.equals(b.data),
    ).toBe(true);
  });
});

function endpointPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\armadra-test-${process.pid}-${randomBytes(4).toString("hex")}`
    : join(tempDir("armadra-pp-"), "t.sock");
}

describe("the handshake in front of an HTTP server", () => {
  const open: { close: () => void }[] = [];
  afterEach(() => {
    for (const item of open.splice(0)) item.close();
  });

  async function serve(guard?: Partial<Parameters<typeof guardServer>[1]>) {
    const path = endpointPath();
    const server = createServer((req, res) => {
      res.end(`hello ${req.url}`);
    });
    const seen: string[] = [];
    guardServer(server, {
      channel: channel(),
      onReject: (r) => seen.push(r),
      ...guard,
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    open.push({ close: () => server.close() });
    return { path, server, seen };
  }

  function get(
    path: string,
    ch: Channel,
  ): Promise<{ status: number; body: string }> {
    const agent = new Agent({ keepAlive: false });
    // `createConnection` with a callback is documented on the agent instance.
    (agent as unknown as { createConnection: unknown }).createConnection = (
      _options: unknown,
      callback: (error: Error | null, socket?: Socket) => void,
    ) => {
      connectPrivate(path, ch, 3000).then(
        (socket) => callback(null, socket),
        (error: Error) => callback(error),
      );
    };
    return new Promise((resolve, reject) => {
      const req = request(
        { agent, path: "/x", method: "GET", host: "localhost" },
        (res: IncomingMessage) => {
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(parts).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("serves a request after a mutual handshake", async () => {
    const { path } = await serve();
    expect(await get(path, channel())).toEqual({
      status: 200,
      body: "hello /x",
    });
  });

  it("serves several connections one after another", async () => {
    const { path } = await serve();
    for (let i = 0; i < 3; i++)
      expect((await get(path, channel())).status).toBe(200);
  });

  it("a client with the wrong key rejects the server proof and sends nothing more", async () => {
    const { path } = await serve();
    const wrong = channel("runtime", channelKey(randomBytes(32), "runtime"));
    await expect(connectPrivate(path, wrong, 2000)).rejects.toThrow(
      /bad server proof/,
    );
  });

  it("the server drops a client whose proof is wrong, before any request", async () => {
    const { path, seen } = await serve();
    const received = await new Promise<string>((resolve) => {
      const handshake = new ClientHandshake(channel());
      const socket = connect(path);
      const chunks: Buffer[] = [];
      let sent = false;
      socket.on("connect", () => socket.write(handshake.hello()));
      socket.on("data", (chunk) => {
        if (!sent) {
          sent = true;
          // The real reply is verified, then a random "proof" and a request go back.
          handshake.push(chunk);
          socket.write(
            Buffer.concat([
              randomBytes(32),
              Buffer.from("GET /x HTTP/1.1\r\nHost: a\r\n\r\n"),
            ]),
          );
        } else {
          chunks.push(chunk);
        }
      });
      socket.on("close", () =>
        resolve(Buffer.concat(chunks).toString("latin1")),
      );
      socket.on("error", () => undefined);
    });
    expect(received).not.toContain("HTTP/1.1");
    expect(seen).toContain("bad client proof");
  });

  it("drops a plain HTTP client: it never reaches the request handler", async () => {
    const { path, seen } = await serve({ timeoutMs: 200 });
    const received = await new Promise<string>((resolve) => {
      const socket = connect(path);
      const chunks: Buffer[] = [];
      socket.on("connect", () =>
        socket.write("GET /x HTTP/1.1\r\nHost: a\r\n\r\n"),
      );
      socket.on("data", (c) => chunks.push(c));
      socket.on("close", () =>
        resolve(Buffer.concat(chunks).toString("latin1")),
      );
      socket.on("error", () => undefined);
    });
    expect(received).not.toContain("HTTP/1.1");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("closes a connection that never finishes the handshake", async () => {
    const { path, seen } = await serve({ timeoutMs: 100 });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(path);
      socket.on("close", () => resolve(true));
      socket.on("error", () => undefined);
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
    expect(seen).toContain("handshake timeout");
  });

  it("caps connections waiting on the handshake", async () => {
    const { path, seen } = await serve({ maxPending: 2, timeoutMs: 1000 });
    const sockets: Socket[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connect(path);
      s.on("error", () => undefined);
      sockets.push(s);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(
      seen.filter((r) => r === "too many pending").length,
    ).toBeGreaterThanOrEqual(1);
    for (const s of sockets) s.destroy();
  });
});

describe("a squatter that does not hold the key", () => {
  it("receives only the client's nonce and never the request", async () => {
    const path = endpointPath();
    const received: Buffer[] = [];
    const squatter = netServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk);
        // Answers like a server would, with a made-up proof.
        socket.write(randomBytes(48));
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => squatter.listen(path, resolve));
    try {
      await expect(connectPrivate(path, channel(), 2000)).rejects.toThrow(
        /bad server proof/,
      );
      await new Promise((r) => setTimeout(r, 50));
      // Exactly the 20-byte hello: no proof, no request bytes.
      expect(Buffer.concat(received)).toHaveLength(CLIENT_HELLO_BYTES);
    } finally {
      squatter.close();
    }
  });

  it("times out against a server that never answers", async () => {
    const path = endpointPath();
    const silent = netServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    try {
      await expect(connectPrivate(path, channel(), 150)).rejects.toThrow(
        /timeout/,
      );
    } finally {
      silent.close();
    }
  });
});

describe("the pipe key file", () => {
  it("is created once, 32 bytes, and read back identically", () => {
    const dir = tempDir("armadra-pipekey-");
    const first = ensurePipeKey(dir);
    expect(first).toHaveLength(32);
    expect(existsSync(pipeKeyPath(dir))).toBe(true);
    expect(ensurePipeKey(dir).equals(first)).toBe(true);
    expect(readPipeKey(dir).equals(first)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(pipeKeyPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it("a reader never creates one", () => {
    expect(() => readPipeKey(tempDir("armadra-pipekey-"))).toThrow();
  });
});

describe.skipIf(process.platform !== "win32")("a real named pipe", () => {
  it("is served only after the handshake and reports its ACL state", async () => {
    const name = `armadra-test-real-${process.pid}`;
    const server = createServer((_req, res) => res.end("ok"));
    const warnings: string[] = [];
    const spec: ListenSpec = { kind: "pipe", name };
    await bind(server, spec, {
      channel: { label: "runtime", key: channelKey(root, "runtime") },
      harden: async () => ({ ok: false, reason: "test" }),
      onWarning: (m) => warnings.push(m),
    });
    try {
      expect(pipeAclSummary()).toBe("default");
      expect(warnings.some((w) => w.includes("handshake alone"))).toBe(true);
      const socket = await connectPrivate(`\\\\.\\pipe\\${name}`, {
        label: "runtime",
        pipe: name,
        key: channelKey(root, "runtime"),
      });
      socket.destroy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      release(spec);
    }
    expect(pipeAclSummary()).toBeUndefined();
  });

  it("refuses to bind a pipe without a key", async () => {
    await expect(
      bind(createServer(), {
        kind: "pipe",
        name: `armadra-test-nokey-${process.pid}`,
      }),
    ).rejects.toThrow(/without a handshake key/);
  });
});
