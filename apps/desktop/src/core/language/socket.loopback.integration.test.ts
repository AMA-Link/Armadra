/**
 * 语言服务的会话流在回环门开着时（契约 §3.2，安全审查 L9，#337）。
 *
 * `routes.integration.test.ts` 验语言域本身，裸 core 显式打开了回环匿名；这里
 * 关着它，和两种壳一样：会话经回环会话的 Bearer 建，流要一次性票，票绑来源、
 * 只能用一次，然后 `didOpen` → 诊断照常往返。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";
import { settingsDomain } from "../settings";
import {
  type LoopbackSession,
  loopbackSession,
} from "../testing/loopback-session";
import { MOCK_LSP } from "./fixture";
import type { JsonObject } from "./jsonrpc";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

async function start(): Promise<{ core: RunningCore; root: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-language-gate-"));
  const root = mkdtempSync(join(tmpdir(), "armadra-language-gate-root-"));
  directories.push(dataDir, root);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    // 不带 `ARMADRA_LOOPBACK_OWNER`：回环匿名关着，与两种壳相同。
    env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  running.push(core);
  return { core, root };
}

function base(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `http://${tcp.host}:${tcp.port}`;
}

function createWorkspace(core: RunningCore, id: string, root: string): void {
  core.db.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, permissions_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      id,
      root,
      JSON.stringify({ read: true, write: true, execute: true }),
      "2026-10-12T00:00:00Z",
      "2026-10-12T00:00:00Z",
    );
}

/** 与 `routes.integration.test.ts` 同一个替身语言服务器。 */
function plantMockServer(): void {
  const program = process.execPath;
  const settings = settingsDomain()?.settings;
  if (settings === undefined) throw new Error("settings are not assembled");
  settings.patch({
    language: {
      servers: { marksman: { path: program, args: [MOCK_LSP] } },
      probes: {
        local: {
          marksman: {
            serverId: "marksman",
            program,
            executable: program,
            version: "1.0.0",
            status: "ok",
            exitCode: 0,
            probedAt: new Date().toISOString(),
          },
        },
      },
    },
  });
}

async function openSession(
  core: RunningCore,
  session: LoopbackSession,
): Promise<string> {
  const opened = await session.fetch("/api/workspaces/ws-1/language/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ languageId: "markdown", clientId: "node-1" }),
  });
  expect(opened.status).toBe(200);
  return ((await opened.json()) as JsonObject)["sessionId"] as string;
}

type Upgrade =
  | { readonly kind: "open"; readonly socket: WebSocket }
  | { readonly kind: "refused"; readonly status: number };

function upgrade(
  core: RunningCore,
  path: string,
  origin: string,
  protocols: string[],
): Promise<Upgrade> {
  const socket = new WebSocket(
    `${base(core).replace("http", "ws")}${path}`,
    protocols,
    { origin },
  );
  sockets.push(socket);
  return new Promise((resolve_) => {
    socket.once("open", () => resolve_({ kind: "open", socket }));
    socket.once("unexpected-response", (_request, response) =>
      resolve_({ kind: "refused", status: response.statusCode ?? 0 }),
    );
    socket.once("error", () => resolve_({ kind: "refused", status: -1 }));
  });
}

async function waitFor(
  frames: readonly JsonObject[],
  matches: (frame: JsonObject) => boolean,
  timeoutMs = 20_000,
): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(matches);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("no matching frame arrived");
    await new Promise((resolve_) => setTimeout(resolve_, 25));
  }
}

describe("语言服务会话流过回环的门", () => {
  it("没带会话建不了会话；没带票升级 401", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root);
    plantMockServer();
    const session = await loopbackSession(core, base(core));

    const anonymous = await fetch(
      `${base(core)}/api/workspaces/ws-1/language/sessions`,
      {
        method: "POST",
        headers: {
          origin: session.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ languageId: "markdown", clientId: "node-1" }),
      },
    );
    expect(anonymous.status).toBe(401);

    const sessionId = await openSession(core, session);
    const path = `/api/workspaces/ws-1/language/sessions/${sessionId}/stream`;
    expect(await upgrade(core, path, session.origin, [])).toEqual({
      kind: "refused",
      status: 401,
    });
  }, 60_000);

  it("带票升级：didOpen → 诊断往返；同一张票再用 401", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root);
    writeFileSync(join(root, "notes.md"), "line\nTODO here\n", "utf8");
    plantMockServer();
    const session = await loopbackSession(core, base(core));
    const sessionId = await openSession(core, session);
    const path = `/api/workspaces/ws-1/language/sessions/${sessionId}/stream`;

    const ticket = await session.wsProtocol();
    const opened = await upgrade(core, path, session.origin, [ticket]);
    expect(opened.kind).toBe("open");
    if (opened.kind !== "open") return;
    const frames: JsonObject[] = [];
    opened.socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)) as JsonObject);
    });
    opened.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "armadra:///notes.md",
            languageId: "markdown",
            version: 1,
            text: "line\nTODO here\n",
          },
        },
      }),
    );
    const published = await waitFor(
      frames,
      (frame) => frame["method"] === "textDocument/publishDiagnostics",
    );
    expect((published["params"] as JsonObject)["uri"]).toBe(
      "armadra:///notes.md",
    );
    expect(JSON.stringify(published)).not.toContain("file://");

    opened.socket.close();
    expect(await upgrade(core, path, session.origin, [ticket])).toEqual({
      kind: "refused",
      status: 401,
    });
  }, 60_000);

  it("别的回环来源换的票：401", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root);
    plantMockServer();
    const mine = await loopbackSession(core, base(core));
    const stranger = await loopbackSession(
      core,
      base(core),
      "http://127.0.0.1:2",
    );
    const sessionId = await openSession(core, mine);
    const path = `/api/workspaces/ws-1/language/sessions/${sessionId}/stream`;
    expect(
      await upgrade(core, path, mine.origin, [await stranger.wsProtocol()]),
    ).toEqual({ kind: "refused", status: 401 });
  }, 60_000);
});
