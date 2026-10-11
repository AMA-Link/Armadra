import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";

import { ROUTES } from "../http/routes";
import { selfGuarded } from "../http/route-scopes";
import { Router, emptyRequest } from "../http/router";
import type { AuthorizationSubject } from "./authorize";
import { runAs } from "./gate";
import { hostRoleScopes, roleScopes, sessionViewerScopes } from "./roles";
import { createRouteGuard } from "./route-access";
import { type Scope, permits, scope } from "./scopes";

/**
 * 只读分享的全量矩阵（契约 §68，远程访问重设计「只读由服务端判定」）：把路由表
 * （`http/routes.ts`）里每一条 runtime 路由、契约里每一条带 `meta.scope` 的
 * procedure 都拿去问真的路由门（`route-access.ts`），问的人是三种只读分享——
 * 工作空间 viewer、整台 viewer、只看一条会话。
 *
 *   * **写一律拒**：非 GET / HEAD 的方法、以及能写的 GET（终端附着 `…/ws`）；
 *   * **读不越过 viewer 的四项**（`canvas:read` / `events:read` / `terminal:read` /
 *     `assets:read`）：文件、git、设置这些读同样拒；只有路由门明写的「无害的全局读」
 *     （Agent 目录、模型目录、终端后端、用量状态、发布历史）放行。
 *
 * 服务器壳上 HTTP 拒绝答 403，控制面（`/api/ws`）上的 procedure 走同一道门
 * （`http/rpc.ts`），复核失败按 4403 关；所以这里问门就够了。对象属于哪块画布用
 * 一张假表回答：画板 b1、终端 t1、节点 n1、审批 p1 … 都在 w1 上——给门最有利的
 * 条件，仍然要拒。
 *
 * 门本身（`route-access.ts`、`canvas/routes.ts`）不在这个分支改：矩阵发现的缺口
 * 记在 {@link KNOWN_GAPS}，由负责路由门的分支修掉之后从表里删。
 */

const VIEWER_PERMISSIONS = new Set([
  "canvas:read",
  "events:read",
  "terminal:read",
  "assets:read",
]);

const VIEWERS: Record<string, readonly Scope[]> = {
  "ws-viewer": roleScopes("viewer", "w1"),
  "host-viewer": hostRoleScopes("viewer"),
  "sess-viewer": sessionViewerScopes("w1", "t1"),
};

/** 路由门明写的「无害的全局读」（`route-access.ts` 的 `SHARED_READS`）。 */
const SHARED_READS: readonly RegExp[] = [
  /^\/api\/agents$/,
  /^\/api\/agents\/[^/]+\/models$/,
  /^\/api\/models\/catalog$/,
  /^\/api\/terminals\/backend$/,
  /^\/api\/usage\/status$/,
  /^\/api\/updates\/releases$/,
];

/**
 * 有意放给 viewer 的「写」：不改画布内容、不写盘、不碰终端（`route-scopes.ts` 里写明的）。
 *
 *   * 标已读只是清掉节点头上的未读点（`agent-status/{nodeId}/read` 要 `canvas:read`）；
 *   * 在线设备的心跳与离开（契约 §9.1）：只读的客户端也要让别人看见自己在看；
 *   * 「打开」只记最近打开的时间。
 */
const INTENDED_WRITES = new Set([
  "POST /api/agent-status/{nodeId}/read",
  "POST /api/workspaces/{workspaceId}/boards/{boardId}/presence",
  "DELETE /api/workspaces/{workspaceId}/boards/{boardId}/presence/{clientId}",
  "POST /api/workspaces/{workspaceId}/open",
]);

/** 每个登录主体的底线（控制面升级、`system.hello` / `ping`）：不是分享给的权限。 */
const BASELINE_READS = new Set(["identity:read"]);

/**
 * 矩阵发现、尚未修掉的缺口：`<方法> <路径模式>` → 哪几种 viewer 过得去。
 * 路由门归另一个分支（share-host-visibility），修好后删掉对应的行。
 *
 *   * 导出 PNG / 文本（契约 §37.3）会往工作区写文件（`.armadra/exports/…`，文本至多
 *     1 MiB），`route-scopes.ts` 的 `exports/` 一行只写了 `read: "assets:read"`，写方法
 *     沿用它；域里的 `permissions.write` 判的是工作空间是否只读打开，不是这个人。
 */
const KNOWN_GAPS: Record<string, string> = {
  "POST /api/workspaces/{workspaceId}/exports/{exportId}/png":
    "host-viewer,ws-viewer",
  "POST /api/workspaces/{workspaceId}/exports/{exportId}/text":
    "host-viewer,ws-viewer",
};

const PARAMS: Record<string, string> = {
  workspaceId: "w1",
  boardId: "b1",
  nodeId: "n1",
  sessionId: "t1",
  pendingId: "p1",
  requestId: "c1",
  draftId: "d1",
  runId: "r1",
  taskId: "k1",
};

const lookups = {
  sessionWorkspace: (id: string) => (id === "t1" ? "w1" : ""),
  // 终端是 owner 起的：对 viewer 永远是「别人的」。
  sessionCreator: () => "",
  recordCreator: () => undefined,
  inheritedCreator: () => null,
  nodeSession: (id: string) => (id === "n1" ? "t1" : ""),
  nodeOwner: () => "",
  nodeWorkspace: (id: string) => (id === "n1" ? "w1" : ""),
  approvalWorkspace: (id: string) => (id === "p1" ? "w1" : ""),
  approvalCreator: () => "",
  boardWorkspace: (id: string) => (id === "b1" ? "w1" : ""),
  workflowDraftWorkspace: (id: string) => (id === "d1" ? "w1" : ""),
  workflowRunWorkspace: (id: string) => (id === "r1" ? "w1" : ""),
  workflowTaskWorkspace: (id: string) => (id === "k1" ? "w1" : ""),
  confirmWorkspace: (id: string) => (id === "c1" ? "w1" : ""),
};

function subject(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

const granted = (who: AuthorizationSubject) => [
  ...who.scopes,
  ...(VIEWERS[who.principalId] ?? []),
];

const guard = createRouteGuard({
  database: {} as DatabaseSync,
  permits: (who, required) => permits(granted(who), required),
  effectiveScopes: granted,
  lookups,
});
const router = new Router();

/** 给门最有利的体：画布、节点、画板都在 w1 上。 */
const BODY = { workspaceId: "w1", nodeId: "n1", boardId: "b1" };

function fill(pattern: string, values: Record<string, unknown> = {}): string {
  return pattern.replace(/\{([^}]+)\}/g, (_whole, key: string) => {
    const value = values[key] ?? PARAMS[key] ?? "x";
    return encodeURIComponent(String(value));
  });
}

/** 哪几种 viewer 过得了门（按名字排序后用逗号连起来；没有是空串）。 */
function passes(
  method: string,
  path: string,
  requirement = router.requiredScope(method, path),
  body: Record<string, unknown> = BODY,
): string {
  return Object.keys(VIEWERS)
    .filter((who) => {
      const request = {
        ...emptyRequest(method, path),
        query: new URLSearchParams({ boardId: "b1" }),
        body: Buffer.from(JSON.stringify(body), "utf8"),
        json: <T>() => body as T,
      };
      return runAs({ subject: subject(who) }, () => guard(request, requirement))
        .allowed;
    })
    .sort()
    .join(",");
}

function writes(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return true;
  // 附着到终端的 socket 能写（路由门按写判）。
  return /^\/api\/terminals\/[^/]+\/ws$/.test(path);
}

describe("只读分享的全量矩阵：路由表的每一条", () => {
  const routes = ROUTES.filter(
    (entry) => entry.surface === "runtime" && entry.implemented === true,
  );

  it("路由表不是空的，五个家族都在", () => {
    for (const family of [
      "/api/workspaces/{workspaceId}/boards",
      "/api/workspaces/{workspaceId}/file",
      "/api/terminals",
      "/api/workspaces/{workspaceId}/git",
      "/api/agents",
    ]) {
      expect(
        routes.some((entry) => entry.path.startsWith(family)),
        family,
      ).toBe(true);
    }
  });

  it("写一律拒，读不越过 viewer 的四项（除了明写的无害全局读）", () => {
    const found: Record<string, string> = {};
    for (const entry of routes) {
      const path = fill(entry.path);
      if (selfGuarded(path)) continue;
      for (const method of entry.methods) {
        const key = `${method} ${entry.path}`;
        const allowed = passes(method, path);
        if (allowed === "") continue;
        if (writes(method, path)) {
          if (INTENDED_WRITES.has(key)) continue;
          found[key] = allowed;
          continue;
        }
        if (SHARED_READS.some((pattern) => pattern.test(path))) continue;
        const requirement = router.requiredScope(method, path);
        if (
          requirement !== undefined &&
          (VIEWER_PERMISSIONS.has(requirement.permission) ||
            BASELINE_READS.has(requirement.permission))
        )
          continue;
        found[key] = allowed;
      }
    }
    expect(found).toEqual(KNOWN_GAPS);
  });

  it("各家族的代表：写画布、写文件、终端输入与附着、git 写、起 Agent 都拒", () => {
    for (const [method, pattern] of [
      ["POST", "/api/workspaces/{workspaceId}/boards"],
      ["PUT", "/api/workspaces/{workspaceId}/boards/{boardId}"],
      ["DELETE", "/api/workspaces/{workspaceId}/boards/{boardId}"],
      ["POST", "/api/workspaces/{workspaceId}/file"],
      ["POST", "/api/terminals"],
      ["POST", "/api/terminals/{sessionId}/paste"],
      ["GET", "/api/terminals/{sessionId}/ws"],
      ["POST", "/api/acp/sessions"],
      ["POST", "/api/acp/sessions/{sessionId}/prompt"],
      ["POST", "/api/approvals/{pendingId}/answer"],
      ["POST", "/api/workflows/runs"],
    ] as const) {
      const path = fill(pattern);
      expect(passes(method, path), `${method} ${pattern}`).toBe("");
    }
  });

  it("对照：同样的门放 viewer 读画布与它那一条终端", () => {
    expect(passes("GET", "/api/workspaces/w1/boards")).toBe(
      "host-viewer,ws-viewer",
    );
    expect(passes("GET", "/api/terminals/t1/capture")).toBe(
      "host-viewer,sess-viewer,ws-viewer",
    );
  });
});

describe("只读分享的全量矩阵：契约的每一条 procedure", () => {
  /** 与 `http/rpc.ts` 的 `gateRequest` 同一个拼法：有旧路径的拿旧路径去问。 */
  function gate(
    name: string,
    meta: {
      scope?: string | null;
      workspaceKey?: string;
      legacy?: { method: string; path: string };
    },
  ): string {
    const input: Record<string, unknown> = { ...BODY, ...PARAMS };
    let method = "POST";
    let path = `rpc:${name}`;
    const fields = { ...input };
    if (meta.legacy !== undefined) {
      method = meta.legacy.method;
      path = meta.legacy.path.replace(/\{([^}]+)\}/g, (_whole, key: string) => {
        const value = fields[key];
        delete fields[key];
        return encodeURIComponent(typeof value === "string" ? value : "x");
      });
    }
    const workspaceId =
      meta.workspaceKey === undefined
        ? ""
        : String(input[meta.workspaceKey] ?? "");
    return passes(
      method,
      path,
      { permission: meta.scope as string, workspaceId },
      fields,
    );
  }

  it("写的 procedure 一律拒；读的不越过 viewer 的四项", () => {
    const found: Record<string, string> = {};
    let checked = 0;
    for (const entry of contractEntries()) {
      const meta = entry.meta;
      if (meta.scope === null || meta.scope === undefined) continue;
      checked += 1;
      if (BASELINE_READS.has(meta.scope)) continue;
      const allowed = gate(entry.name, meta);
      if (allowed === "") continue;
      const legacy = meta.legacy;
      const path =
        legacy === undefined ? "" : fill(legacy.path, { ...BODY, ...PARAMS });
      if (legacy !== undefined && selfGuarded(path)) continue;
      if (
        legacy !== undefined &&
        INTENDED_WRITES.has(`${legacy.method} ${legacy.path}`)
      )
        continue;
      if (
        legacy !== undefined &&
        legacy.method === "GET" &&
        SHARED_READS.some((pattern) => pattern.test(path))
      )
        continue;
      if (VIEWER_PERMISSIONS.has(meta.scope)) {
        // 读的那四项：只有真的是读才算数。
        const reading =
          legacy === undefined
            ? !/^(create|update|delete|remove|set|put|write|send|start|stop|kill|answer|prompt|launch|run|cancel)/i.test(
                entry.path[entry.path.length - 1] ?? "",
              )
            : !writes(legacy.method, path);
        if (reading) continue;
      }
      found[entry.name] = allowed;
    }
    expect(checked).toBeGreaterThan(50);
    expect(found).toEqual(KNOWN_PROCEDURE_GAPS);
  });
});

/** 同 {@link KNOWN_GAPS}，按 procedure 名（`files.exportText` 就是导出文本那一条）。 */
const KNOWN_PROCEDURE_GAPS: Record<string, string> = {
  "files.exportText": "host-viewer,ws-viewer",
};
