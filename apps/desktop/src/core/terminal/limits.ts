import type { DatabaseSync } from "node:sqlite";
import { fail } from "../http/errors";
import { isOwner } from "../identity/authorize";
import { currentSubject } from "../identity/gate";
import type { SpawnRequest } from "./spawn-request";

/** `limits.terminalsPerPrincipal` / `limits.agentsPerWorkspace`；`0` = 不限。 */
export interface CoreLimits {
  readonly terminalsPerPrincipal: number;
  readonly agentsPerWorkspace: number;
}

/**
 * 单台 core 的上限（平台设计 A6-2，契约 §85）：一个成员（非 owner 的
 * principal）名下运行中的终端、成员名下的会话所在工作空间里运行中的 Agent 会话。
 * 超出答 `429 limit_reached { scope, limit, current }`。**owner 与没有请求身份的
 * 动作（core 自己开的：依赖编排、定时冷启动、休眠唤醒的还原、桌面壳）两个上限都
 * 不适用**——上限防的是一个成员占满主机，不是限制单人桌面。同一节点重新起会话
 * 不重复计。
 */
export function enforceLimits(
  database: DatabaseSync,
  limits: CoreLimits | undefined,
  request: SpawnRequest,
): void {
  if (limits === undefined) return;
  const subject = currentSubject();
  if (isOwner(subject) || subject.principalId === "") return;
  const count = (sql: string, ...params: (string | null)[]): number =>
    Number((database.prepare(sql).get(...params) as { n: number }).n);
  if (request.agentId !== undefined) {
    const limit = limits.agentsPerWorkspace;
    if (limit <= 0) return;
    const current = count(
      "SELECT COUNT(*) AS n FROM terminal_sessions WHERE workspace_id = ? " +
        "AND status = 'running' AND agent_id IS NOT NULL " +
        "AND (owner_node_id IS NULL OR owner_node_id IS NOT ?)",
      request.workspaceId,
      request.ownerNodeId ?? null,
    );
    if (current >= limit) {
      throw fail(
        "limit_reached",
        `这个工作空间最多同时运行 ${limit} 个 Agent`,
        { scope: "workspace", limit, current },
      );
    }
    return;
  }
  const limit = limits.terminalsPerPrincipal;
  if (limit <= 0) return;
  const current = count(
    "SELECT COUNT(*) AS n FROM terminal_sessions WHERE creator_principal_id = ? " +
      "AND status = 'running' AND agent_id IS NULL",
    subject.principalId,
  );
  if (current >= limit) {
    throw fail("limit_reached", `每个成员最多同时打开 ${limit} 个终端`, {
      scope: "principal",
      limit,
      current,
    });
  }
}

/**
 * 同一个上限键（成员 / 工作空间）上的 spawn 排队：判定与插行之间隔着异步的后端
 * `create`，不排队的话并发的几个请求会同时看到「还有名额」。
 */
export class LimitGate {
  constructor(
    private readonly database: DatabaseSync,
    private readonly limits: (() => CoreLimits) | undefined,
  ) {}

  private readonly tails = new Map<string, Promise<unknown>>();

  /** 受上限的 spawn 排队判定再建；不受上限的（owner、core 自己）直接建。 */
  guard<T>(request: SpawnRequest, work: () => Promise<T>): Promise<T> {
    const limits = this.limits?.();
    const subject = currentSubject();
    if (
      limits === undefined ||
      isOwner(subject) ||
      subject.principalId === ""
    ) {
      return work();
    }
    const key =
      request.agentId !== undefined
        ? `ws:${request.workspaceId}`
        : `principal:${subject.principalId}`;
    return this.run(key, async () => {
      enforceLimits(this.database, limits, request);
      return work();
    });
  }

  private run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
