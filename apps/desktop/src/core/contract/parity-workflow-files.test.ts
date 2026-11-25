import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { installContract } from "../http/rpc";
import type { AuthorizationSubject } from "../identity/authorize";
import { installRouteGuard, resetRouteGuard } from "../identity/gate";
import { type ShareRole, roleScopes } from "../identity/roles";
import { createRouteGuard } from "../identity/route-access";
import { type Scope, permits, scope } from "../identity/scopes";
import { WorkflowEngine } from "../workflow/engine";
import { setWorkflowDomain } from "../workflow/registry";
import { installWorkflowRoutes } from "../workflow/routes";
import { WorkflowService } from "../workflow/service";
import { type JsonValue, canonicalJson } from "./message";

/**
 * 项目级工作流文件的对偶测试（契约 §121）：`workflows.files`、
 * `workflows.importFile`、`workflows.exportTemplate` 与旧路径同一份操作，三种答法
 * 一致；路由门按工作空间判，被拒时磁盘上一个字节都没变。做法同
 * `parity-workflows.test.ts`。
 */

let f: AgentFixture;
let engine: WorkflowEngine;
let base: string;
let workspaceId: string;

const DRAFT = {
  version: 2,
  title: "一步",
  roles: [{ id: "worker", agentId: "codex" }],
  steps: [{ id: "s1", kind: "prompt", role: "worker", prompt: "做" }],
};

const GRANTS: Record<string, ShareRole | undefined> = {
  driver: "driver",
  operator: "operator",
  editor: "editor",
  viewer: "viewer",
  outsider: undefined,
};

function subject(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

function granted(principalId: string): Scope[] {
  const role = GRANTS[principalId];
  return role === undefined ? [] : [...roleScopes(role, workspaceId)];
}

beforeAll(async () => {
  f = agentFixture();
  engine = new WorkflowEngine({
    database: f.database,
    collab: () => f.collab,
    sweepEveryMs: false,
    launch: () => {},
  });
  const service = new WorkflowService({
    database: f.database,
    engine,
    collab: () => f.collab,
  });
  setWorkflowDomain({ engine, service, stop: () => engine.stop() });
  installWorkflowRoutes(f.server, service);
  installContract(f.server, { validateOutput: true, platform: f.platform });
  f.server.admission((request) => {
    const who = request.headers["x-parity-as"];
    return typeof who === "string"
      ? { identity: { subject: subject(who) } }
      : {};
  });
  const listener = f.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  workspaceId = f.workspaceId;
});

afterAll(async () => {
  setWorkflowDomain(undefined);
  await engine.stop();
  await f.server.close();
  f.close();
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** 迁移前的答法：路由表里那条 handler。 */
async function table(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const answer = await f.call(method, path, body);
  return { status: answer.status, body: answer.body };
}

/** 旧路径，经 HTTP；`as` 是服务器壳上的成员。 */
async function legacy(
  method: string,
  path: string,
  body?: unknown,
  as?: string,
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as !== undefined) headers["x-parity-as"] = as;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** 新 procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(
  name: string,
  input?: unknown,
  as?: string,
): Promise<Answer> {
  const response = await fetch(`${base}/api/rpc/${name.replace(".", "/")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(as === undefined ? {} : { "x-parity-as": as }),
    },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const text = await response.text();
  const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

function stable(value: unknown, volatile: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map((one) => stable(one, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    out[key] = volatile.has(key) ? "<volatile>" : stable(field, volatile);
  }
  return out;
}

/** 三种答法：状态一样（procedure 成功恒为 200），体规范化后逐字节相等。 */
function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  volatile: ReadonlySet<string> = new Set(),
): void {
  const text = (answer: Answer) => canonicalJson(stable(answer.body, volatile));
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  expect(text(rest), "旧路径的体").toBe(text(old));
  expect(text(rpc), "procedure 的体").toBe(text(old));
}

async function thrice<T>(
  run: (kind: "table" | "legacy" | "rpc") => Promise<T>,
): Promise<readonly [T, T, T]> {
  return [await run("table"), await run("legacy"), await run("rpc")];
}

function ask(
  kind: "table" | "legacy" | "rpc",
  method: string,
  path: string,
  name: string,
  input: Record<string, unknown>,
  body?: unknown,
): Promise<Answer> {
  if (kind === "table") return table(method, path, body);
  if (kind === "legacy") return legacy(method, path, body);
  return procedure(name, input);
}

const W = "/api/workflows";

async function template(): Promise<string> {
  const created = await table("POST", `${W}/templates`, {
    name: "模板",
    template: DRAFT,
  });
  expect(created.status).toBe(201);
  return (created.body as { template: { id: string } }).template.id;
}

describe("项目级工作流文件：三种答法一致，路由门按工作空间判", () => {
  const FILE = `---
version: 2
title: 文件里的流程
roles:
  - id: a
    agentId: codex
steps:
  - id: s
    kind: prompt
    role: a
    prompt: 做事
---
`;

  beforeAll(() => {
    mkdirSync(join(f.directory, ".ama", "workflows"), { recursive: true });
    writeFileSync(join(f.directory, ".ama", "workflows", "flow.md"), FILE);
    installRouteGuard(
      createRouteGuard({
        database: f.database,
        permits: (who, required) =>
          permits([...who.scopes, ...granted(who.principalId)], required),
        effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
      }),
    );
  });
  afterAll(() => resetRouteGuard());

  async function both(
    as: string,
    method: string,
    path: string,
    body: unknown,
    name: string,
    input: unknown,
  ): Promise<[Answer, Answer]> {
    const rest = await legacy(method, path, body, as);
    const rpc = await procedure(name, input, as);
    expect(rpc.status, `${as} ${name}`).toBe(
      rest.status >= 400 ? rest.status : 200,
    );
    if (rest.status >= 400) expect(rpc.body).toEqual(rest.body);
    return [rest, rpc];
  }

  it("files、importFile、exportTemplate", async () => {
    const answers = await thrice((kind) =>
      ask(
        kind,
        "GET",
        `${W}/files?workspaceId=${workspaceId}`,
        "workflows.files",
        { workspaceId },
      ),
    );
    expect(answers[0].status).toBe(200);
    expect(
      (answers[0].body as { files: { id: string }[] }).files.map((x) => x.id),
    ).toEqual(["flow"]);
    expectParity(answers, new Set(["templateId"]));

    const imported = await thrice((kind) =>
      ask(
        kind,
        "POST",
        `${W}/files/import`,
        "workflows.importFile",
        { workspaceId, id: "flow" },
        { workspaceId, id: "flow" },
      ),
    );
    // 表上的 handler 新建答 201，之后两次是更新过的同一个模板：`unchanged`。
    expect(imported.map((answer) => answer.status)).toEqual([201, 200, 200]);
    expect(
      imported.map((answer) => (answer.body as { change: string }).change),
    ).toEqual(["created", "unchanged", "unchanged"]);
    const templateId = (
      imported[0].body as { template: { id: string; fileRef: string } }
    ).template.id;

    const exported = await thrice((kind) =>
      ask(
        kind,
        "POST",
        `${W}/templates/${templateId}/export`,
        "workflows.exportTemplate",
        { templateId, workspaceId, id: "flow" },
        { workspaceId, id: "flow" },
      ),
    );
    for (const answer of exported) {
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ code: "workflow_file_exists" });
    }
    const overwritten = await thrice((kind) =>
      ask(
        kind,
        "POST",
        `${W}/templates/${templateId}/export`,
        "workflows.exportTemplate",
        { templateId, workspaceId, id: "flow", overwrite: true },
        { workspaceId, id: "flow", overwrite: true },
      ),
    );
    expectParity(overwritten);
    expect(overwritten[0].body).toEqual({
      path: ".ama/workflows/flow.md",
      id: "flow",
    });
  });

  it("读是看画布；导入只有 owner；导出要对那个工作空间有 files:write", async () => {
    const list = `${W}/files?workspaceId=${workspaceId}`;
    for (const as of ["viewer", "editor", "operator"]) {
      const [rest] = await both(as, "GET", list, undefined, "workflows.files", {
        workspaceId,
      });
      expect(rest.status, as).toBe(200);
    }
    for (const as of ["outsider", "stranger"]) {
      const [rest] = await both(as, "GET", list, undefined, "workflows.files", {
        workspaceId,
      });
      expect(rest.status, as).toBe(403);
    }
    const importBody = { workspaceId, id: "flow" };
    for (const as of ["viewer", "operator", "driver"]) {
      const [rest] = await both(
        as,
        "POST",
        `${W}/files/import`,
        importBody,
        "workflows.importFile",
        importBody,
      );
      expect(rest.status, as).toBe(403);
    }
    const id = await template();
    const out = { workspaceId, id: "from-gate", overwrite: true };
    for (const as of ["viewer", "editor", "outsider", "stranger"]) {
      const [rest] = await both(
        as,
        "POST",
        `${W}/templates/${id}/export`,
        out,
        "workflows.exportTemplate",
        { templateId: id, ...out },
      );
      expect(rest.status, as).toBe(403);
    }
    expect(
      existsSync(join(f.directory, ".ama", "workflows", "from-gate.md")),
    ).toBe(false);
    const ok = await procedure(
      "workflows.exportTemplate",
      { templateId: id, ...out },
      "operator",
    );
    expect(ok.status).toBe(200);
  });
});
