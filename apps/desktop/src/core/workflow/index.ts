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
import { deliverPullBatch } from "../collab/pr-fanout";
import { forgeService } from "../forge/registry";
import {
  deliverRecoveryHint,
  recordInterrupted,
  recordStalled,
  recordTaskDone,
} from "../collab/router-sources";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { rowLiveness, timelineDomainOf } from "../timeline";
import { WorkflowEngine } from "./engine";
import { RECOVERY_GRACE_MS, RecoveryScan } from "./recovery";
import {
  DEFAULT_NEEDS_HUMAN_MINUTES,
  DEFAULT_STALLED_MINUTES,
  ProgressWatchdog,
} from "./progress-watchdog";
import { PrWatch } from "./pr-watch";
import { installWorkflowRoutes } from "./routes";
import { type WorkflowDomain, setWorkflowDomain } from "./registry";
import { WorkflowService } from "./service";
import { TaskWatch } from "./task-watch";
import { publishTask } from "./task-runs";

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
      if (ctx !== undefined) recordStalled(ctx, wake);
    },
    log: (message, fields) => context.log.info(message, fields),
  });
  setStallSource(watchdog);
  // 重启恢复（契约 §101.5）：同样搭 60 秒兜底扫描的便车；成员续接后第一次报告
  // 空闲时补投恢复提示。
  const recovery = new RecoveryScan({
    database,
    alive: (nodeId) => {
      const session = loadSession(database, nodeId);
      if (session?.status === "running") return true;
      if (session === undefined) return false;
      // 休眠着等接回的节点（Eco 模式）不算中断。
      return (
        collab()?.terminals?.sleeping?.(nodeId) === true ||
        rowLiveness(database, session.sessionId) === "sleeping"
      );
    },
    record: (run, atMs) => {
      const ctx = collab();
      return ctx === undefined ? false : recordInterrupted(ctx, run, atMs);
    },
    deliver: (run) => {
      const ctx = collab();
      return ctx === undefined ? false : deliverRecoveryHint(ctx, run);
    },
    log: (message, fields) => context.log.info(message, fields),
  });
  const offStatus = context.bus.on("workspace.event", ({ event }) => {
    if (event.type !== "agent.status") return;
    const status = event.status as { nodeId?: unknown; state?: unknown };
    if (typeof status.nodeId !== "string") return;
    try {
      recovery.onStatus(
        status.nodeId,
        typeof status.state === "string" ? status.state : undefined,
      );
    } catch (error) {
      context.log.info("恢复提示没有投成", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  // 启动后过了宽限先扫一次，不等第一个 60 秒。
  const firstScan = setTimeout(() => {
    try {
      recovery.scan();
    } catch (error) {
      context.log.info("启动扫描失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, RECOVERY_GRACE_MS + 1_000);
  firstScan.unref?.();
  // 绑定 PR 的拉取式轮询（契约 §103）：同样搭 60 秒兜底扫描的便车，每个线程自己
  // 按 60 秒与服务端给的间隔到点才读。
  const pulls = new PrWatch({
    database,
    forge: forgeService,
    deliver: (run, thread, batch) => {
      const ctx = collab();
      if (ctx !== undefined) deliverPullBatch(ctx, run, thread, batch);
    },
    onSettled: (run, result) => {
      const ctx = collab();
      if (ctx === undefined) return;
      publishTask(database, ctx.publish, run.taskId);
      recordTaskDone(ctx, run, "done", result);
    },
    log: (message, fields) => context.log.info(message, fields),
  });
  const tasks = new TaskWatch({
    database,
    bus: context.bus,
    publish: () => collab()?.publish,
    log: (message, fields) => context.log.info(message, fields),
    onTick: () => {
      watchdog.scan();
      recovery.scan();
      void pulls.tick().catch((error: unknown) => {
        context.log.info("PR 轮询没有跑完", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onSettled: (run, status) => {
      const ctx = collab();
      if (ctx !== undefined) recordTaskDone(ctx, run, status);
    },
  });
  tasks.start();
  const domain: WorkflowDomain = {
    engine,
    service,
    stop: async () => {
      tasks.stop();
      offStatus();
      clearTimeout(firstScan);
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
