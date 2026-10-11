/**
 * 分享出去的人看得见什么（契约 §60，#308）：起一个真 core，owner 配对、建工作空间、
 * 画板与一个终端，再给一个成员整台 / 工作空间 / 会话三种授予，按他的会话走一遍
 * 「打开画布」要用的那几条路由，并附着终端：只能读的人附得上、看得见画面、写不进去；
 * 能驱动的人照旧写得进去。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { type RunningCore, run } from "../main";
import { putGrantRow } from "./grant-sync";
import { identityInstanceId } from "./index";
import { type GrantTargetKind, HOST_WORKSPACE, type ShareRole } from "./roles";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Session {
  readonly base: string;
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly principalId: string;
}

async function start(): Promise<{ core: RunningCore; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-share-visibility-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
  });
  running.push(core);
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return { core, base: `http://${tcp.host}:${tcp.port}` };
}

async function pair(core: RunningCore, base: string): Promise<Session> {
  const store = new IdentityStore(core.db.database);
  const service = new IdentityService(store, identityInstanceId());
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: identityInstanceId(),
    origin: base,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const response = await fetch(`${base}/api/identity/pair`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ ticket: ticket.ticket }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    native?: { accessToken: string };
    csrfToken: string;
    device: { principalId: string };
  };
  return {
    base,
    accessToken: body.native?.accessToken ?? "",
    csrfToken: body.csrfToken,
    principalId: body.device.principalId,
  };
}

async function call(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${session.base}${path}`, {
    method,
    headers: {
      origin: session.base,
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
      "x-armadra-csrf": session.csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不是 JSON 就原样留着。
  }
  return { status: response.status, body: parsed };
}

/** 建一个成员、设口令、给一条授予、登录。 */
async function member(
  core: RunningCore,
  owner: Session,
  grant: {
    targetKind: GrantTargetKind;
    workspaceId?: string;
    targetId?: string;
    role: ShareRole;
  },
): Promise<Session> {
  const created = await call(owner, "POST", "/api/identity/principals", {
    displayName: "访客",
  });
  expect(created.status).toBe(201);
  const principalId = (created.body as { principalId: string }).principalId;
  expect(
    (
      await call(owner, "POST", "/api/identity/credentials", {
        principalId,
        kind: "password",
        password: "correct horse battery",
      })
    ).status,
  ).toBe(201);
  const store = new IdentityStore(core.db.database);
  store.transaction((tx) =>
    putGrantRow(tx.accounts, {
      subjectKind: "principal",
      subjectId: principalId,
      workspaceId:
        grant.targetKind === "host"
          ? HOST_WORKSPACE
          : (grant.workspaceId ?? ""),
      targetKind: grant.targetKind,
      targetId: grant.targetId ?? "",
      role: grant.role,
      grantedBy: owner.principalId,
      nowMs: Date.now(),
    }),
  );
  const login = await fetch(`${owner.base}/api/identity/login`, {
    method: "POST",
    headers: { origin: owner.base, "content-type": "application/json" },
    body: JSON.stringify({
      principalId,
      password: "correct horse battery",
      deviceName: "访客的笔记本",
    }),
  });
  expect(login.status).toBe(200);
  const issued = (await login.json()) as {
    native?: { accessToken: string };
    csrfToken: string;
  };
  return {
    base: owner.base,
    accessToken: issued.native?.accessToken ?? "",
    csrfToken: issued.csrfToken,
    principalId,
  };
}

async function seed(owner: Session, root: string) {
  const workspace = await call(owner, "POST", "/api/workspaces", {
    name: "分享",
    rootPath: root,
  });
  expect(workspace.status, JSON.stringify(workspace.body)).toBe(200);
  const workspaceId = (workspace.body as { id: string }).id;
  const boards = await call(
    owner,
    "GET",
    `/api/workspaces/${workspaceId}/boards`,
  );
  expect(boards.status, JSON.stringify(boards.body)).toBe(200);
  const terminal = async () => {
    // `cat` 把收到的每一行原样回显：谁的输入落进了终端，画面上就有它。
    const created = await call(owner, "POST", "/api/terminals", {
      workspaceId,
      cwd: root,
      command: "/bin/sh",
      args: ["-c", "echo ready; exec cat"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return (created.body as { id: string }).id;
  };
  return {
    workspaceId,
    boards: boards.body,
    sessionId: await terminal(),
    otherSessionId: await terminal(),
  };
}

/** 换票、附着终端；答升级的结果与一个往里写的函数。 */
async function attach(
  session: Session,
  sessionId: string,
): Promise<
  | { status: number }
  | { status: 101; send(line: string): void; output(): string; close(): void }
> {
  const ticket = await call(session, "POST", "/api/identity/ws-ticket", {});
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
  const url = `${session.base.replace("http:", "ws:")}/api/terminals/${sessionId}/ws`;
  const socket = new WebSocket(
    url,
    [`armadra-ticket.${(ticket.body as { ticket: string }).ticket}`],
    { headers: { origin: session.base } },
  );
  let text = "";
  return new Promise((resolve) => {
    socket.on("unexpected-response", (_request, response) => {
      resolve({ status: response.statusCode ?? 0 });
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as {
        type: string;
        data?: string;
      };
      if (frame.type === "hello") {
        resolve({
          status: 101,
          send: (line) =>
            socket.send(JSON.stringify({ type: "input", data: `${line}\r` })),
          output: () => text,
          close: () => socket.close(),
        });
      }
      if (typeof frame.data === "string") text += frame.data;
    });
  });
}

/** 终端画面（owner 看到的）。 */
async function screen(owner: Session, sessionId: string): Promise<string> {
  const answer = await call(
    owner,
    "GET",
    `/api/terminals/${sessionId}/capture`,
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return JSON.stringify(answer.body);
}

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

async function setup() {
  const { core, base } = await start();
  const owner = await pair(core, base);
  const root = mkdtempSync(join(tmpdir(), "armadra-share-root-"));
  directories.push(root);
  return { core, owner, ...(await seed(owner, root)) };
}

// 终端用 /bin/sh 与 cat，Windows 上没有。
describe.skipIf(process.platform === "win32")(
  "分享出去的人看得见内容（契约 §60，#308）",
  () => {
    for (const [target, role] of [
      ["host", "viewer"],
      ["host", "editor"],
      ["workspace", "viewer"],
    ] as const) {
      it(`${target === "host" ? "整台" : "工作空间"} ${role}：列得出工作空间、打得开画板，终端只读附着`, async () => {
        const { core, owner, workspaceId, boards, sessionId } = await setup();
        const guest = await member(core, owner, {
          targetKind: target,
          workspaceId,
          role,
        });

        const listed = await call(guest, "GET", "/api/workspaces");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(
          (listed.body as { id: string }[]).map((one) => one.id),
        ).toContain(workspaceId);
        const rpcListed = await call(
          guest,
          "POST",
          "/api/rpc/workspaces/list",
          {
            json: {},
          },
        );
        expect(rpcListed.status, JSON.stringify(rpcListed.body)).toBe(200);
        expect(
          (await call(guest, "POST", `/api/workspaces/${workspaceId}/open`, {}))
            .status,
        ).toBe(200);
        const guestBoards = await call(
          guest,
          "GET",
          `/api/workspaces/${workspaceId}/boards`,
        );
        expect(guestBoards.status).toBe(200);
        expect(guestBoards.body).toEqual(boards);
        expect(
          (await call(guest, "GET", `/api/workspaces/${workspaceId}/sessions`))
            .status,
        ).toBe(200);

        // 修之前：`…/ws` 按写入判，只能读的人一律 403，终端节点一片空白。
        const attached = await attach(guest, sessionId);
        expect(attached.status).toBe(101);
        if (!("send" in attached)) return;
        expect(
          await eventually(async () => attached.output().includes("ready")),
        ).toBe(true);
        attached.send("guest-was-here");
        await new Promise((done) => setTimeout(done, 400));
        expect(await screen(owner, sessionId)).not.toContain("guest-was-here");
        attached.close();
      });
    }

    it("能驱动的人附着照旧可写", async () => {
      const { core, owner, sessionId } = await setup();
      const guest = await member(core, owner, {
        targetKind: "host",
        role: "driver",
      });
      const attached = await attach(guest, sessionId);
      expect(attached.status).toBe(101);
      if (!("send" in attached)) return;
      attached.send("driver-was-here");
      expect(
        await eventually(async () =>
          (await screen(owner, sessionId)).includes("driver-was-here"),
        ),
      ).toBe(true);
      attached.close();
    });

    it("会话查看者：只读附着那一条会话，别的会话与画布照旧 403", async () => {
      const { core, owner, workspaceId, sessionId, otherSessionId } =
        await setup();
      const guest = await member(core, owner, {
        targetKind: "session",
        workspaceId,
        targetId: sessionId,
        role: "viewer",
      });
      const attached = await attach(guest, sessionId);
      expect(attached.status).toBe(101);
      if (!("send" in attached)) return;
      expect(
        await eventually(async () => attached.output().includes("ready")),
      ).toBe(true);
      attached.send("session-viewer-was-here");
      await new Promise((done) => setTimeout(done, 400));
      expect(await screen(owner, sessionId)).not.toContain(
        "session-viewer-was-here",
      );
      attached.close();

      expect((await attach(guest, otherSessionId)).status).toBe(403);
      expect(
        (await call(guest, "GET", `/api/workspaces/${workspaceId}/boards`))
          .status,
      ).toBe(403);
      expect(
        (
          await call(guest, "POST", `/api/terminals/${sessionId}/paste`, {
            text: "x",
          })
        ).status,
      ).toBe(403);
    });
  },
);
