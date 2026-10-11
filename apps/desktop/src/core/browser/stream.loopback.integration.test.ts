/**
 * 浏览器画面流在回环门开着时（契约 §3.2，安全审查 L9，#337）。
 *
 * 真 core、回环匿名关着（与两种壳相同）；headless 后端换成替身——这里验的是
 * 门与这条流的往返，不是 Chromium（那在 `headless/live.integration.test.ts`）。
 * 不带票 401；带票升级后收到头帧 + JPEG，页面发的 `viewport` 到达节点；票绑
 * 来源、只能用一次。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type RunningCore, run } from "../main";
import { loopbackSession } from "../testing/loopback-session";
import { HeadlessBackend } from "./headless";
import type { HeadlessNode, ViewerSocket } from "./headless/node";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.close();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const NODE_ID = "11111111-2222-4333-8444-555555555555";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

/** 替身节点：有人看就推一帧，记下观看者发来的每条消息。 */
function standInNode() {
  const messages: unknown[] = [];
  let viewer: ViewerSocket | null = null;
  const node = {
    hasViewer: () => viewer !== null,
    attachViewer(socket: ViewerSocket) {
      viewer = socket;
      const header = JSON.stringify({
        type: "frame",
        seq: 1,
        width: 2,
        height: 1,
        bytes: JPEG.length,
      });
      if (socket.sendFrame) socket.sendFrame(header, JPEG);
      else {
        socket.send(header);
        socket.send(JPEG);
      }
    },
    detachViewer(socket: ViewerSocket) {
      if (viewer === socket) viewer = null;
    },
    onViewerMessage(raw: unknown) {
      messages.push(JSON.parse(String(raw)));
    },
  };
  return { node: node as unknown as HeadlessNode, messages };
}

async function start(): Promise<RunningCore> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-browser-gate-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    // 不带 `ARMADRA_LOOPBACK_OWNER`，也不带壳的 drive 通道：headless 后端。
    env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  running.push(core);
  const now = "2026-10-12T00:00:00.000Z";
  const database = core.db.database;
  database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("ws-1", "ws-1", dataDir, now, now);
  database
    .prepare(
      "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("board-1", "ws-1", "Board", now, now);
  database
    .prepare(
      `INSERT INTO nodes (id, board_id, type, x, y, width, height, title, data_json,
           created_at, updated_at)
         VALUES (?, 'board-1', 'browser', 0, 0, 400, 300, 'Docs', ?, ?, ?)`,
    )
    .run(NODE_ID, JSON.stringify({ url: "https://example.com/" }), now, now);
  return core;
}

function base(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `http://${tcp.host}:${tcp.port}`;
}

const STREAM = `/api/workspaces/ws-1/browser/${NODE_ID}/stream`;

type Upgrade =
  | {
      readonly kind: "open";
      readonly socket: WebSocket;
      /** 从升级那一刻起收到的每条消息（帧可能在 `open` 之后立刻就到）。 */
      readonly received: { readonly binary: boolean; readonly data: Buffer }[];
    }
  | { readonly kind: "refused"; readonly status: number };

function upgrade(
  core: RunningCore,
  origin: string,
  protocols: string[],
): Promise<Upgrade> {
  const socket = new WebSocket(
    `${base(core).replace("http", "ws")}${STREAM}`,
    protocols,
    { origin },
  );
  sockets.push(socket);
  const received: { binary: boolean; data: Buffer }[] = [];
  socket.on("message", (data: Buffer, binary: boolean) => {
    received.push({ binary, data });
  });
  return new Promise((resolve_) => {
    socket.once("open", () => resolve_({ kind: "open", socket, received }));
    socket.once("unexpected-response", (_request, response) =>
      resolve_({ kind: "refused", status: response.statusCode ?? 0 }),
    );
    socket.once("error", () => resolve_({ kind: "refused", status: -1 }));
  });
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve_) => setTimeout(resolve_, 10));
  }
}

describe("浏览器画面流过回环的门", () => {
  it("不带票 401；带票收到头帧 + JPEG，viewport 到达节点", async () => {
    const stand = standInNode();
    const ensure = vi
      .spyOn(HeadlessBackend.prototype, "ensure")
      .mockResolvedValue(stand.node);
    const core = await start();
    const session = await loopbackSession(core, base(core));

    expect(await upgrade(core, session.origin, [])).toMatchObject({
      kind: "refused",
      status: 401,
    });
    expect(ensure).not.toHaveBeenCalled();

    const opened = await upgrade(core, session.origin, [
      await session.wsProtocol(),
    ]);
    expect(opened.kind).toBe("open");
    if (opened.kind !== "open") return;
    const binaries = () =>
      opened.received.filter((one) => one.binary).map((one) => one.data);
    await until(() => binaries().length > 0);
    const texts = opened.received
      .filter((one) => !one.binary)
      .map((one) => JSON.parse(one.data.toString("utf8")) as unknown);
    expect(texts[0]).toMatchObject({ type: "frame", width: 2, height: 1 });
    expect(binaries()[0]?.equals(JPEG)).toBe(true);
    expect(ensure).toHaveBeenCalledWith(NODE_ID, "https://example.com/");

    opened.socket.send(
      JSON.stringify({ type: "viewport", width: 800, height: 600 }),
    );
    await until(() => stand.messages.length > 0);
    expect(stand.messages[0]).toEqual({
      type: "viewport",
      width: 800,
      height: 600,
    });
  });

  it("票只能用一次；别的回环来源换的票 401", async () => {
    vi.spyOn(HeadlessBackend.prototype, "ensure").mockResolvedValue(
      standInNode().node,
    );
    const core = await start();
    const mine = await loopbackSession(core, base(core));
    const stranger = await loopbackSession(
      core,
      base(core),
      "http://127.0.0.1:2",
    );

    expect(
      await upgrade(core, mine.origin, [await stranger.wsProtocol()]),
    ).toMatchObject({ kind: "refused", status: 401 });

    const ticket = await mine.wsProtocol();
    const first = await upgrade(core, mine.origin, [ticket]);
    expect(first.kind).toBe("open");
    if (first.kind === "open") first.socket.close();
    expect(await upgrade(core, mine.origin, [ticket])).toMatchObject({
      kind: "refused",
      status: 401,
    });
  });
});
