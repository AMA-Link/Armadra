/**
 * 对着一个真的个人中转（armadra-cloud 的 `personal serve`，自签 TLS）跑契约 §32 的
 * 整条路：真 core（`run()`）登记 → 隧道连上 → 客户端用中继地址 + 中继令牌 + 断言开
 * 端到端通道（`@armadra/shared/e2e`，契约 §78；中继只转这一条，明文请求答 404）、新设备
 * 由本机主人核对校验码放行，再经通道换会话访问 core：HTTP API、事件流、终端收发、
 * 实时协作板；中继令牌失效 4401 后换令牌与票重连；中继重启后隧道自己重连；本机撤销即断；中继侧撤销后本机登记
 * 跟着撤销。真 TLS、真指纹钉扎、真 Ed25519。
 *
 * `ARMADRA_PERSONAL_RELAY=1` 才跑；否则 skipped。其余从环境读：
 *
 *   * `ARMADRA_PERSONAL_RELAY_HOME`：armadra-cloud 的检出目录。给了它，测试自己起
 *     中继（Go 二进制 `armadra-relay personal serve`：`ARMADRA_RELAY_BIN`，否则检出里的
 *     `go/bin/armadra-relay`，每次增量 `go build`、找不到 go 时沿用已有的；数据在检出的 `.data/personal/`），读那里的
 *     `dev.env` 与 CA 算指纹，并跑「中继重启」那一条；
 *   * 不给就连已经在跑的中继：`ARMADRA_PERSONAL_RELAY_URL`（缺省
 *     `https://127.0.0.1:8102`）、`ARMADRA_PERSONAL_RELAY_FP`、
 *     `ARMADRA_PERSONAL_RELAY_ACCOUNT` / `_PASSWORD`，跳过重启那一条。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ed25519SignerFromSeed } from "@armadra/platform-protocol/e2e";
import {
  E2eChannelError,
  E2eClientChannel,
  channelFetch,
  channelWebSocket,
} from "@armadra/shared/e2e";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { listBoards } from "../canvas/boards";
import { stickyNode } from "../canvas/nodes.fixture";
import { type RunningCore, run } from "../main";
import { nodesOf, projectDoc } from "../realtime/doc";
import { MESSAGE_SYNC } from "../realtime/sync";
import {
  type LoopbackSession,
  loopbackSession,
} from "../testing/loopback-session";
import { createWorkspace } from "../workspaces/table";

const enabled = process.env.ARMADRA_PERSONAL_RELAY === "1";
const home = process.env.ARMADRA_PERSONAL_RELAY_HOME?.trim() ?? "";
const issuer = new URL(
  process.env.ARMADRA_PERSONAL_RELAY_URL?.trim() || "https://127.0.0.1:8102",
).origin;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

function devEnv(): Record<string, string> {
  if (home === "") return {};
  const file = join(home, ".data", "personal", "dev.env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

const env = devEnv();
const account =
  process.env.ARMADRA_PERSONAL_RELAY_ACCOUNT?.trim() ||
  env.PERSONAL_RELAY_ACCOUNT ||
  "dev";
const password =
  process.env.ARMADRA_PERSONAL_RELAY_PASSWORD ??
  env.PERSONAL_RELAY_PASSWORD ??
  "";

/** 中继的 CA（钉扎用）：`/ca.crt` 由测试在起中继之后取。 */
let caPem = "";
let fingerprint = process.env.ARMADRA_PERSONAL_RELAY_FP?.trim() ?? "";

let relayProcess: ChildProcess | undefined;
let core: RunningCore;
let dataDir: string;
let base: string;
let own: LoopbackSession;
let relayAccess = "";
let sourceId = "";
let tunnelAccess = "";
let workspaceId = "";
let boardId = "";

/* ------------------------------ 中继进程 ------------------------------ */

async function relayUp(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const answer = await relayCall("GET", "/.well-known/armadra-platform", {
        insecure: true,
      });
      if (answer.status === 200) return;
    } catch {
      // 还没起来。
    }
    if (Date.now() > deadline) throw new Error("个人中转没有起来");
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * Go 中继二进制：ARMADRA_RELAY_BIN，否则检出里的 go/bin/armadra-relay——每次增量 go build，
 * 找不到 go 时沿用已有的并警告。
 */
function relayBin(): string {
  const given = process.env.ARMADRA_RELAY_BIN?.trim();
  if (given) return resolve(given);
  const bin = join(home, "go", "bin", "armadra-relay");
  const built = spawnSync("go", ["build", "-o", bin, "./cmd/armadra-relay"], {
    cwd: join(home, "go"),
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if ((built.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    if (!existsSync(bin))
      throw new Error("找不到 go，检出里也没有构建好的中继");
    console.warn(`找不到 go：沿用已有的 ${bin}`);
  } else if (built.status !== 0) {
    throw new Error(
      `go build armadra-relay 失败：${built.stderr.slice(-1500)}`,
    );
  }
  return bin;
}

function startRelay(): void {
  const port = new URL(issuer).port || "443";
  relayProcess = spawn(
    relayBin(),
    [
      "personal",
      "serve",
      "--data-dir",
      join(home, ".data", "personal"),
      "--host",
      "127.0.0.1",
      "--port",
      port,
      "--tls",
      "self-signed",
    ],
    { cwd: home, stdio: "ignore" },
  );
}

async function stopRelay(): Promise<void> {
  const child = relayProcess;
  relayProcess = undefined;
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await exited;
}

/* --------------------------- 对中继的 HTTP --------------------------- */

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  body: Record<string, unknown>;
}

function relayCall(
  method: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
    insecure?: boolean;
  } = {},
): Promise<Answer> {
  const target = new URL(url, issuer);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve_, reject) => {
    const outgoing = httpsRequest(
      target,
      {
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }),
          ...options.headers,
        },
        ...(options.insecure === true || caPem === ""
          ? { rejectUnauthorized: false }
          : { ca: caPem }),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown> = {};
          try {
            body =
              text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
          } catch {
            body = {};
          }
          resolve_({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            body,
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

/** 中继 `/v1/*`，带中继账号的会话。 */
function v1(method: string, path: string, body?: unknown, token = relayAccess) {
  return relayCall(method, path, {
    ...(body === undefined ? {} : { body }),
    headers: token === "" ? {} : { authorization: `Bearer ${token}` },
  });
}

/** 中继签一张断言 + 中继令牌（客户端要经中继访问 core 的那两样）。 */
async function assertion(): Promise<{
  assertion: string;
  relayToken: string;
  relayBaseUrl: string;
}> {
  const answer = await v1("POST", `/v1/sources/${sourceId}/assertion`, {
    sourceId,
    device: { platform: "desktop", name: "relay-e2e" },
  });
  expect(answer.status, answer.text).toBe(200);
  return answer.body as never;
}

let relayToken = "";
let relayBaseUrl = "";

/* ------------------------- 端到端通道（契约 §78） ------------------------- */

/** 这台"设备"的钥：整个测试用同一个种子，放行一次之后的通道都是已信任设备。 */
const deviceSeed = randomBytes(32);
let channel: E2eClientChannel | undefined;
/** 钉住的 core 身份：第一次开通道记下，之后变了就拒绝。 */
let corePin: Uint8Array | undefined;

/** 底层 WebSocket 用 `ws`，钉中继的自签 CA。 */
function pinnedSocket(): typeof globalThis.WebSocket {
  class PinnedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { perMessageDeflate: false, ca: caPem });
    }
  }
  return PinnedSocket as unknown as typeof globalThis.WebSocket;
}

async function openChannel(
  token = relayToken,
  /** false = 不带钉住的 core 身份（验证中继拒绝时用：钉住后握手被中继掐断会被报成身份变了）。 */
  pin = true,
): Promise<E2eClientChannel> {
  const opened = await E2eClientChannel.open({
    url: `${relayBaseUrl.replace(/^https:/, "wss:")}/_relay/e2e`,
    relayToken: token,
    sourceId,
    device: await ed25519SignerFromSeed(new Uint8Array(deviceSeed)),
    platform: "desktop",
    name: "relay-e2e",
    WebSocket: pinnedSocket(),
    pingIntervalMs: 0,
    ...(!pin || corePin === undefined ? {} : { pinned: corePin }),
  });
  corePin ??= opened.coreIdentity;
  return opened;
}

/** 当前这条通道；断了或到期就用当前的中继令牌重开。 */
async function current(): Promise<E2eClientChannel> {
  if (channel === undefined || channel.closed || channel.expired) {
    channel?.close();
    channel = undefined;
    channel = await openChannel();
  }
  return channel;
}

/** 经通道打 core（客户端视角）：来源 = 中继自己（可信来源）。 */
async function viaRelay(
  method: string,
  path: string,
  body?: unknown,
  token: string | undefined = tunnelAccess,
  extra: Record<string, string> = {},
): Promise<Answer> {
  const open = await current();
  const fetcher = channelFetch(open, { origin: issuer, base: relayBaseUrl });
  const response = await fetcher(`${relayBaseUrl}${path}`, {
    method,
    headers: {
      ...extra,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined || token === ""
        ? {}
        : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = {};
  }
  const headers: Record<string, string | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text, body: parsed };
}

async function ticket(): Promise<string> {
  const answer = await viaRelay("POST", "/api/identity/ws-ticket");
  expect(answer.status, answer.text).toBe(200);
  return answer.body.ticket as string;
}

type RelayedSocket = InstanceType<typeof globalThis.WebSocket>;

/** 经通道升级 WebSocket：子协议是票（中继令牌在通道握手里验过了）。 */
async function wsViaRelay(
  path: string,
  options: { ticket: string },
): Promise<{
  socket: RelayedSocket;
  /** 升级成功 101；core 在通道里拒绝（如票用过）连不上是 0。 */
  status: number;
  closeCode?: number;
  /** 从升级起收到的每一帧（流一开就发的 hello 不会漏）。 */
  messages: Buffer[];
}> {
  const open = await current();
  const Socket = channelWebSocket(open, { origin: issuer, base: relayBaseUrl });
  const socket = new Socket(`${relayBaseUrl}${path}`, [
    `armadra-ticket.${options.ticket}`,
  ]);
  socket.binaryType = "arraybuffer";
  const messages: Buffer[] = [];
  socket.addEventListener("message", (event) =>
    messages.push(
      typeof event.data === "string"
        ? Buffer.from(event.data)
        : Buffer.from(new Uint8Array(event.data as ArrayBuffer)),
    ),
  );
  return new Promise((resolve_) => {
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      // core 拒绝时也先完成升级再关：等一小会儿看它是不是马上被关。
      const timer = setTimeout(
        () => resolve_({ socket, status: 101, messages }),
        300,
      );
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve_({ socket, status: 101, closeCode: event.code, messages });
      });
    });
    socket.addEventListener("close", (event) => {
      if (!opened)
        resolve_({ socket, status: 0, closeCode: event.code, messages });
    });
  });
}

/** 这条 WebSocket 关掉时的关闭码。 */
function closedOf(socket: RelayedSocket): Promise<number> {
  return new Promise((done) =>
    socket.addEventListener("close", (event) => done(event.code)),
  );
}

async function tunnelState(): Promise<string> {
  const answer = await own.fetch("/api/identity/cloud");
  const body = (await answer.json()) as {
    registrations: { tunnel: { state: string } }[];
  };
  return body.registrations[0]?.tunnel.state ?? "none";
}

async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function register(): Promise<void> {
  const token = await v1("POST", "/v1/sources/registration-tokens", {});
  expect(token.status, token.text).toBe(200);
  const registered = await own.fetch("/api/identity/cloud/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      issuer,
      registrationToken: token.body.registrationToken,
    }),
  });
  expect(registered.status, await registered.clone().text()).toBe(200);
  await until(async () => (await tunnelState()) === "ready");
}

describe.skipIf(!enabled)("个人中转联调：隧道（契约 §32）", () => {
  beforeAll(async () => {
    if (home !== "") {
      startRelay();
      await relayUp();
    }
    const ca = await relayCall("GET", "/ca.crt", { insecure: true });
    caPem = ca.text;
    const computed = createHash("sha256")
      .update(new X509Certificate(caPem).raw)
      .digest("hex");
    if (fingerprint === "") fingerprint = computed;
    expect(computed).toBe(fingerprint);

    dataDir = mkdtempSync(join(tmpdir(), "armadra-relay-e2e-"));
    process.env.ARMADRA_SECRET_BACKEND = "file";
    core = await run({
      argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
      env: {
        ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
        ARMADRA_LOG: "error",
        ARMADRA_SECRET_BACKEND: "file",
      },
      stdout: () => {},
    });
    const tcp = core.bound.find((spec) => spec.kind === "tcp");
    if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
    base = `http://${tcp.host}:${tcp.port}`;
    own = await loopbackSession(core, base);

    const login = await v1(
      "POST",
      "/v1/auth/login",
      { account, password, device: { platform: "desktop", name: "relay-e2e" } },
      "",
    );
    expect(login.status, login.text).toBe(200);
    relayAccess = (login.body.session as { accessToken: string }).accessToken;
    const added = await own.fetch("/api/rpc/sources/remoteAdd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: { kind: "personal", issuer, account, password, fingerprint },
      }),
    });
    expect(added.status, await added.clone().text()).toBe(200);
    const workspace = createWorkspace(core.db.database, {
      name: "relay-e2e",
      rootPath: realpathSync(dataDir),
    });
    workspaceId = workspace.id;
    boardId = listBoards(core.db.database, workspaceId)[0]!.id;
  }, 60_000);

  afterAll(async () => {
    channel?.close();
    if (sourceId !== "" && relayAccess !== "") {
      await v1("DELETE", `/v1/sources/${sourceId}`).catch(() => undefined);
    }
    await core?.stop();
    await stopRelay();
    if (dataDir !== undefined)
      rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it("登记（A2-3 的 register）之后隧道连上中继", async () => {
    const started = Date.now();
    await register();
    const status = await own.fetch("/api/identity/cloud");
    const body = (await status.json()) as {
      sourceId: string;
      registrations: { tunnel: Record<string, unknown> }[];
    };
    sourceId = body.sourceId;
    expect(body.registrations[0]?.tunnel).toMatchObject({
      state: "ready",
      lastError: null,
    });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("经中继：断言换会话，HTTP API 可用（不发 Cookie）", async () => {
    // owner 先把中继账号映射到自己。
    const first = await assertion();
    const bound = await own.fetch("/api/identity/cloud/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: first.assertion }),
    });
    expect(bound.status, await bound.clone().text()).toBe(200);
    const second = await assertion();
    relayToken = second.relayToken;
    relayBaseUrl = second.relayBaseUrl;
    expect(relayBaseUrl).toBe(`${issuer}/s/${sourceId}`);
    // 新设备：core 答 403 device_pending 并带申请号；本机主人核对通道握手推出的
    // 校验码后放行（契约 §77），再登录一次。
    const attempt = () =>
      viaRelay(
        "POST",
        "/api/identity/cloud/login",
        { assertion: second.assertion },
        "",
      );
    let login = await attempt();
    expect(login.status, login.text).toBe(403);
    expect(login.body.code).toBe("device_pending");
    const pendingId = (login.body.details as { pendingId: string }).pendingId;
    const approved = await own.fetch("/api/devices/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingId, sas: (await current()).sas }),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    login = await attempt();
    expect(login.status, login.text).toBe(200);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const session = login.body.session as {
      csrfToken: string;
      native?: { accessToken: string; refreshToken: string };
    };
    expect(session.native?.accessToken).toBeTruthy();
    // 刷新同样经中继（Bearer 带刷新令牌 + 会话的 CSRF 密钥），换来的新访问令牌照样能用。
    const refreshed = await viaRelay(
      "POST",
      "/api/identity/session/refresh",
      undefined,
      session.native?.refreshToken ?? "",
      { "x-armadra-csrf": session.csrfToken },
    );
    expect(refreshed.status, refreshed.text).toBe(200);
    tunnelAccess =
      (refreshed.body.native as { accessToken?: string } | undefined)
        ?.accessToken ?? "";
    expect(tunnelAccess).not.toBe("");
    expect(tunnelAccess).not.toBe(session.native?.accessToken);
    const workspaces = await viaRelay("GET", "/api/workspaces");
    expect(workspaces.status, workspaces.text).toBe(200);
    expect(JSON.stringify(workspaces.body)).toContain(workspaceId);
    // 带中继令牌的明文请求中继一律答 404，不进隧道（契约 §78）。
    const plain = await relayCall("GET", `${relayBaseUrl}/api/workspaces`, {
      headers: {
        origin: issuer,
        "armadra-relay-token": relayToken,
        authorization: `Bearer ${tunnelAccess}`,
      },
    });
    expect(plain.status, plain.text).toBe(404);
    // 回环专用路径经中继一律 403；没有 Bearer 401。
    expect((await viaRelay("GET", "/hook/health")).status).toBe(403);
    expect(
      (await viaRelay("GET", "/api/workspaces", undefined, "")).status,
    ).toBe(401);
  }, 30_000);

  it("经中继：事件流收到本机发布的事件", async () => {
    const opened = await wsViaRelay(`/api/workspaces/${workspaceId}/events`, {
      ticket: await ticket(),
    });
    expect(opened.status).toBe(101);
    expect(opened.closeCode).toBeUndefined();
    const frames = () =>
      opened.messages.map(
        (data) => JSON.parse(data.toString("utf8")) as { type: string },
      );
    core.bus.emit("workspace.event", {
      workspaceId,
      event: { type: "workspace.updated", workspaceId },
    });
    await until(() =>
      frames().some((frame) => frame.type === "workspace.updated"),
    );
    opened.socket.close();
  }, 30_000);

  it("经中继：开一个终端收发数据", async () => {
    const created = await viaRelay("POST", "/api/terminals", {
      workspaceId,
      cwd: realpathSync(dataDir),
      shell: "/bin/sh",
    });
    expect(created.status, created.text).toBe(200);
    const id = created.body.id as string;
    const opened = await wsViaRelay(
      `/api/terminals/${id}/ws?writer=relay-e2e`,
      {
        ticket: await ticket(),
      },
    );
    expect(opened.status).toBe(101);
    const frames = () =>
      opened.messages.map(
        (data) =>
          JSON.parse(data.toString("utf8")) as { type: string; data?: string },
      );
    await until(() => frames().some((frame) => frame.type === "hello"));
    const marker = `armadra-relay-${Date.now()}`;
    opened.socket.send(
      JSON.stringify({ type: "input", data: `echo ${marker}\r`, inputId: 1 }),
    );
    await until(() =>
      frames().some(
        (frame) =>
          frame.type === "output" && (frame.data ?? "").includes(marker),
      ),
    );
    opened.socket.close();
    const ended = await viaRelay("POST", `/api/terminals/${id}/terminate`, {
      mode: "session",
    });
    expect(ended.status, ended.text).toBe(200);
  }, 30_000);

  it("经中继：实时协作板与回环上的另一端互通", async () => {
    const path = `/api/workspaces/${workspaceId}/boards/${boardId}/sync`;
    const remote = new Y.Doc();
    const local = new Y.Doc();
    const relayed = await wsViaRelay(path, { ticket: await ticket() });
    expect(relayed.status).toBe(101);
    attach(
      {
        send: (data) => relayed.socket.send(data),
        listen: (receive) =>
          relayed.socket.addEventListener("message", (event) =>
            receive(Buffer.from(new Uint8Array(event.data as ArrayBuffer))),
          ),
      },
      remote,
      relayed.messages,
    );
    const loop = new WebSocket(
      `${base.replace("http", "ws")}${path}`,
      [await own.wsProtocol()],
      {
        origin: own.origin,
      },
    );
    loop.binaryType = "nodebuffer";
    await new Promise((done) => loop.once("open", done));
    attach(
      {
        send: (data) => loop.send(data),
        listen: (receive) => loop.on("message", receive),
      },
      local,
    );
    const note = stickyNode(boardId);
    remote.transact(() => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(note)) {
        if (key !== "id" && key !== "boardId") map.set(key, value);
      }
      nodesOf(remote).set(note.id, map);
    });
    await until(() =>
      projectDoc(local, boardId).nodes.some((node) => node.id === note.id),
    );
    const back = stickyNode(boardId);
    local.transact(() => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(back)) {
        if (key !== "id" && key !== "boardId") map.set(key, value);
      }
      nodesOf(local).set(back.id, map);
    });
    await until(() =>
      projectDoc(remote, boardId).nodes.some((node) => node.id === back.id),
    );
    relayed.socket.close();
    loop.close();
  }, 30_000);

  it("4401：中继令牌失效被关，换新令牌与新票重连；用过的票 core 在通道里拒绝", async () => {
    const rejected = await openChannel("not-a-relay-token", false).catch(
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(E2eChannelError);
    expect((rejected as E2eChannelError).closeCode).toBe(4401);
    const fresh = await assertion();
    relayToken = fresh.relayToken;
    // 新令牌重开通道（旧通道只在握手时验过令牌，照旧能用，这里主动换掉）。
    channel?.close();
    channel = undefined;
    const ok = await wsViaRelay(`/api/workspaces/${workspaceId}/events`, {
      ticket: await ticket(),
    });
    expect(ok.status).toBe(101);
    expect(ok.closeCode).toBeUndefined();
    ok.socket.close();
    const t = await ticket();
    const once = await wsViaRelay(`/api/workspaces/${workspaceId}/events`, {
      ticket: t,
    });
    expect(once.status).toBe(101);
    once.socket.close();
    // 用过的票：core 答 401，通道里的升级不成功，这条 WebSocket 没开过就关了。
    const twice = await wsViaRelay(`/api/workspaces/${workspaceId}/events`, {
      ticket: t,
    });
    expect(twice.status).toBe(0);
  }, 30_000);

  it.skipIf(home === "")(
    "中继重启后隧道自己重连",
    async () => {
      const opened = await wsViaRelay(`/api/workspaces/${workspaceId}/events`, {
        ticket: await ticket(),
      });
      expect(opened.status).toBe(101);
      const closed = closedOf(opened.socket);
      await stopRelay();
      await closed;
      await until(async () => (await tunnelState()) !== "ready");
      // 中继不在时本机回环照常。
      expect((await own.fetch("/api/workspaces")).status).toBe(200);
      startRelay();
      await relayUp();
      await until(async () => (await tunnelState()) === "ready", 70_000);
      const again = await viaRelay("GET", "/api/workspaces");
      expect(again.status, again.text).toBe(200);
    },
    120_000,
  );

  it("本机撤销登记：隧道立即断开，经中继的流随之结束", async () => {
    const opened = await wsViaRelay(`/api/workspaces/${workspaceId}/events`, {
      ticket: await ticket(),
    });
    expect(opened.status).toBe(101);
    const closed = closedOf(opened.socket);
    const started = Date.now();
    const revoked = await own.fetch(
      `/api/identity/cloud/register?issuer=${encodeURIComponent(issuer)}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    const code = await closed;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([1006, 4404]).toContain(code);
    expect(await tunnelState()).toBe("none");
    // 本机有这个远程服务的 owner 会话：撤销连同中继侧的源记录一起删（契约
    // §31.4），中继随之作废发给它的中继令牌，经中继的请求答 401 而不是离线 503。
    // 通道随隧道一起断了；新开通道时中继不认这个令牌（4401）。
    channel = undefined;
    const offline = await openChannel(relayToken, false).catch(
      (error: unknown) => error,
    );
    expect(offline).toBeInstanceOf(E2eChannelError);
    expect([4401, 4404]).toContain((offline as E2eChannelError).closeCode);
    const pending = await own.fetch("/api/identity/cloud/relay-pending");
    expect(await pending.json()).toEqual({ pending: [] });
  }, 30_000);

  it("中继侧撤销这台机器：隧道被关，重连时发现已撤销，本机登记跟着撤销", async () => {
    await register();
    const deleted = await v1("DELETE", `/v1/sources/${sourceId}`);
    expect(deleted.status, deleted.text).toBeLessThan(300);
    await until(async () => (await tunnelState()) === "none", 30_000);
  }, 60_000);
});

/** 同步流的一端：收发二进制帧（loopback 上的 `ws`，或经通道的 WebSocket）。 */
interface SyncPeer {
  send(data: Uint8Array): void;
  listen(receive: (data: Buffer) => void): void;
}

/** 一条同步流接到一份客户端文档上（与 `realtime/socket.integration.test.ts` 同一个做法）。 */
function attach(peer: SyncPeer, doc: Y.Doc, earlier: Buffer[] = []): void {
  const receive = (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, "remote");
    if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder));
  };
  for (const data of earlier.splice(0)) receive(data);
  peer.listen(receive);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    peer.send(encoding.toUint8Array(encoder));
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  peer.send(encoding.toUint8Array(encoder));
}
