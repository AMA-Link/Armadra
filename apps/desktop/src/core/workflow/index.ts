/**
 * 工作流域：草案、模板、运行与关卡（协调 Agent 设计 §5；补全架构 §5.4）。
 *
 * 边界：
 *   * 运行在画布上建 Frame、按 `roles` 开节点与连线；投递与 runner 共用
 *     `workflow/dispatch.ts`。
 *   * 页面不在也推进：引擎订阅 bus 事件、周期扫描，与依赖编排同一处判定。
 *   * 路由 `/api/workflows/*` 的权限在 `http/route-scopes.ts`：读
 *     `canvas:read`，写要 operator 那一档（`agent:launch`）；关卡答复的权限
 *     由 G2-9 收紧（契约 §23）。路径里没有工作空间，成员一律 403。契约 §15。
 *
 * **只在工作流的表已经存在时装**（与 `schedule/index.ts` 同款）：没有表就不装，
 * 这一面根本不在，而不是第一个请求撞上一条 SQL 错误。装配排在协作与终端之后：
 * 起节点要借终端桥，投递要借协作上下文，两者都每次现取。
 */

import { collab } from "../agent";
import { setStallSource } from "../agent/stalled";
import { loadSession } from "../collab/nodes";
import { queueWatchWake } from "../collab/wake";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { timelineDomainOf } from "../timeline";
import { WorkflowEngine } from "./engine";
import {
  DEFAULT_NEEDS_HUMAN_MINUTES,
  DEFAULT_STALLED_MINUTES,
  ProgressWatchdog,
} from "./progress-watchdog";
import { installWorkflowRoutes } from "./routes";
import { type WorkflowDomain, setWorkflowDomain } from "./registry";
import { WorkflowService } from "./service";
import { TaskWatch } from "./task-watch";

export { WorkflowEngine } from "./engine";
export { WorkflowService } from "./service";
export { API_PREFIX } from "./routes";

export { setWorkflowDomain, workflowDomain } from "./registry";
export type { WorkflowDomain } from "./registry";

export const WORKFLOW_TABLES = [
  "workflow_drafts",
  "workflow_templates",
  "workflow_runs",
  "workflow_run_steps",
  "workflow_task_runs",
] as const;

export function install(context: CoreContext): WorkflowDomain | undefined {
  if (!context.db.unified || !tablesReady(context)) {
    context.log.info("工作流域未装配：工作流的表尚未建立");
    return undefined;
  }
  const database = context.db.database;
  const engine = new WorkflowEngine({
    database,
    collab: () => collab(),
    bus: context.bus,
    log: (message, fields) => context.log.info(message, fields),
  });
  const service = new WorkflowService({
    database,
    engine,
    collab: () => collab(),
  });
  installWorkflowRoutes(context.server, service);
  engine.start();
  // 协调者分派出去的任务：没人 `wait` 时也落结束（契约 §15.7）。
  // 进展看门狗（契约 §91）搭任务行兜底扫描的便车，不另开定时器。
  const watchdog = new ProgressWatchdog({
    database,
    publish: () => collab()?.publish,
    thresholds: () => ({
      stalledMs: minutesSetting(
        "watchdog.stalledMinutes",
        DEFAULT_STALLED_MINUTES,
      ),
      needsHumanMs: minutesSetting(
        "watchdog.needsHumanMinutes",
        DEFAULT_NEEDS_HUMAN_MINUTES,
      ),
    }),
    lastOutputAt: (nodeId) => {
      const session = loadSession(database, nodeId);
      if (session === undefined) return undefined;
      const output = collab()?.terminals?.observed?.(
        session.sessionId,
      )?.lastOutputAt;
      const timeline = timelineDomainOf(context.server)?.store.get(
        session.sessionId,
      )?.updatedAtMs;
      return Math.max(output ?? 0, timeline ?? 0) || undefined;
    },
    running: (nodeId) => loadSession(database, nodeId)?.status === "running",
    wake: (wake) => {
      const ctx = collab();
      if (ctx !== undefined) queueWatchWake(ctx, wake);
    },
    log: (message, fields) => context.log.info(message, fields),
  });
  setStallSource(watchdog);
  const tasks = new TaskWatch({
    database,
    bus: context.bus,
    publish: () => collab()?.publish,
    log: (message, fields) => context.log.info(message, fields),
    onTick: () => watchdog.scan(),
  });
  tasks.start();
  const domain: WorkflowDomain = {
    engine,
    service,
    stop: async () => {
      tasks.stop();
      setStallSource(undefined);
      watchdog.reset();
      await engine.stop();
      setWorkflowDomain(undefined);
    },
  };
  setWorkflowDomain(domain);
  context.onStop?.(() => domain.stop());
  context.log.info("工作流域已装配");
  return domain;
}

/** 设置里的分钟数 → 毫秒；读不出来用默认，`0` 原样（关）。 */
function minutesSetting(path: string, fallback: number): number {
  const value = settingsDomain()?.settings.get(path);
  const minutes =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : fallback;
  return minutes * 60_000;
}

function tablesReady(context: CoreContext): boolean {
  try {
    const row = context.db.database
      .prepare(
        "SELECT count(*) AS total FROM sqlite_schema WHERE type = 'table' AND name IN (" +
          WORKFLOW_TABLES.map(() => "?").join(", ") +
          ")",
      )
      .get(...WORKFLOW_TABLES) as { total?: unknown } | undefined;
    return Number(row?.total ?? 0) === WORKFLOW_TABLES.length;
  } catch {
    return false;
  }
}
