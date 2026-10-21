/**
 * 会话时间线域（契约 §82，设计 docs/design/session-timeline.md）。
 *
 *   * `store.ts`：`timelines` / `timeline_items`（迁移 0052）的读写，增量同步、翻页、回合索引；
 *   * `blobs.ts`：图片、音频、内嵌资源的字节（`<数据目录>/timeline/blobs/<sha256>`）；
 *   * `writer.ts`：唯一的写入口，合并刷写，对库与帧用同一份压实结果；
 *   * `activity.ts`：活动状态机（粗状态 `agent_status` 之外的细粒度阶段）；
 *   * `routes.ts`：`timeline.*` 四条 procedure 与 blob 的 HTTP 路径。
 *
 * 生产者（B3 的 ACP 会话、B4 的 CLI 来源）拿 {@link timelineDomainOf} 取到域，
 * `open` 登记一条时间线，之后只通过 `writer` 写、通过 `activity` 报生命周期。
 */

import type { DatabaseSync } from "node:sqlite";

import { acpTurnEndOps, type SessionActivity } from "@armadra/shared";

import type { CoreServer } from "../http/server";
import type { CoreContext } from "../main";
import { ActivityTracker } from "./activity";
import { BlobStore } from "./blobs";
import { installRoutes } from "./routes";
import { TimelineStore } from "./store";
import { TimelineWriter } from "./writer";

export { ActivityTracker, contentPhase, outcomeOf } from "./activity";
export { BlobStore, MAX_BLOB_BYTES } from "./blobs";
export { CursorAheadError, TimelineStore } from "./store";
export { TimelineWriter } from "./writer";
export type { TimelineFrame, OpenTimeline } from "./writer";

/** 会话行此刻的存活情况：决定重启后没有活动记录时怎么补。 */
export type Liveness = "alive" | "sleeping" | "gone";

/** 旧时间线（节点已不在库里）保留多久再清。 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export class TimelineDomain {
  readonly store: TimelineStore;
  readonly blobs: BlobStore;
  readonly writer: TimelineWriter;
  readonly activity: ActivityTracker;
  private liveness: ((sessionId: string) => Liveness) | undefined;

  constructor(
    private readonly context: CoreContext,
    options: { readonly bootId?: string } = {},
  ) {
    const database = context.db.database;
    this.store = new TimelineStore(database);
    this.blobs = new BlobStore(context.dataDir, database);
    const bootId = options.bootId ?? Math.random().toString(36).slice(2, 10);
    this.activity = new ActivityTracker({
      bootId,
      publish: (change) =>
        context.bus.emit("workspace.event", {
          workspaceId: change.workspaceId,
          event: {
            type: "timeline.activity",
            timelineId: change.timelineId,
            nodeId: change.nodeId,
            activity: change.activity,
          },
        }),
    });
    this.writer = new TimelineWriter({
      store: this.store,
      blobs: this.blobs,
      log: context.log,
      publish: (frame) =>
        context.bus.emit("workspace.event", {
          workspaceId: frame.workspaceId,
          event: {
            type: "timeline.delta",
            timelineId: frame.timelineId,
            nodeId: frame.nodeId,
            from: frame.from,
            to: frame.to,
            ops: frame.ops as never,
          },
        }),
      onWrite: (event) => this.activity.observe(event.timelineId, event.state),
    });
  }

  /**
   * 登记一条时间线：建行（没有时）、把尾部载入写入器、给活动状态机绑上归属。
   * 幂等；归属以第一次登记为准。
   */
  open(input: {
    readonly timelineId: string;
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly source?: "acp" | "transcript" | "hook" | "core" | "replay";
  }): void {
    this.writer.open(input);
    const row = this.store.get(input.timelineId);
    this.activity.bind(
      input.timelineId,
      row?.workspaceId ?? input.workspaceId,
      row?.nodeId ?? input.nodeId,
    );
  }

  /** 终端域装配后告诉它怎么判一个会话行活没活（缺省按库里的行）。 */
  setLiveness(probe: (sessionId: string) => Liveness): void {
    this.liveness = probe;
  }

  livenessOf(sessionId: string): Liveness {
    if (this.liveness !== undefined) return this.liveness(sessionId);
    return rowLiveness(this.context.db.database, sessionId);
  }

  /**
   * 一条会话此刻的活动：活动状态机里有就用它，没有（core 重启后还没人登记过）
   * 按会话行补一个 `idle` / `sleeping` / `exited`。没有时间线是 `undefined`。
   */
  activityOf(
    sessionId: string,
    liveness?: Liveness,
  ): SessionActivity | undefined {
    const row = this.store.get(sessionId);
    if (row === undefined) return undefined;
    return (
      this.activity.get(sessionId) ??
      this.activity.fallback(
        liveness ?? this.livenessOf(sessionId),
        row.updatedAtMs,
      )
    );
  }

  /** 会话列表每行要的两个字段；没有时间线的会话答 `undefined`（省略）。 */
  summaryOf(
    sessionId: string,
    alive?: boolean,
  ): { activity: SessionActivity; timelineSeq: number } | undefined {
    const row = this.store.get(sessionId);
    if (row === undefined) return undefined;
    const liveness: Liveness | undefined =
      alive === undefined
        ? undefined
        : alive
          ? "alive"
          : this.livenessOf(sessionId) === "sleeping"
            ? "sleeping"
            : "gone";
    const activity = this.activityOf(sessionId, liveness);
    return activity === undefined
      ? undefined
      : { activity, timelineSeq: row.headSeq };
  }

  /**
   * core 重启后的收尾：上一个进程留下的、还没收尾的 ACP 回合（适配器进程早随它没了）
   * 一律记 `cancelled`——挂着的审批变 `cancelled`、流式的条目收尾、跑着的工具记
   * `cancelled`。返回处理了几条时间线。
   */
  recoverInterrupted(): number {
    const database = this.context.db.database;
    const rows = database
      .prepare(
        "SELECT DISTINCT i.timeline_id AS id FROM timeline_items i " +
          "WHERE i.kind = 'turn' AND i.deleted = 0 " +
          "AND json_extract(i.data_json, '$.endedAt') IS NULL " +
          "AND json_extract(i.data_json, '$.source') IN ('acp', 'replay')",
      )
      .all() as { id: string }[];
    let settled = 0;
    for (const { id } of rows) {
      const row = this.store.get(id);
      if (row === undefined) continue;
      this.writer.open({
        timelineId: id,
        workspaceId: row.workspaceId,
        nodeId: row.nodeId,
      });
      const at = Date.now();
      this.writer.write(id, (state) => {
        const ops = [];
        let current = state;
        for (const item of Object.values(state.items)) {
          if (item.kind !== "turn" || item.endedAt !== undefined) continue;
          const part = acpTurnEndOps(
            current,
            { turnId: item.turnId, turn: item.turn, at, gen: item.gen },
            { stopReason: "cancelled" },
          );
          ops.push(...part);
          const last = part[part.length - 1];
          if (last !== undefined) current = { ...current, seq: last.seq };
        }
        return ops;
      });
      this.writer.release(id);
      settled++;
    }
    return settled;
  }

  /** 删掉一条时间线连同它的 blob 字节。 */
  remove(timelineId: string): void {
    this.writer.release(timelineId);
    this.activity.drop(timelineId);
    const blobIds = this.blobs.idsOf(timelineId);
    this.store.remove(timelineId);
    this.blobs.collect(blobIds);
  }

  /** 启动清理：节点早已不在库里的旧时间线。返回清掉几条。 */
  pruneOrphans(nowMs: number = Date.now()): number {
    const ids = this.store.orphans(nowMs - ORPHAN_GRACE_MS);
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  /** 刷空写入器、停掉计时器；关库之前调。 */
  close(): void {
    this.writer.close();
    this.activity.close();
  }
}

/** 只凭 `terminal_sessions` 那一行判存活（没有终端管理器时的缺省）。 */
export function rowLiveness(
  database: DatabaseSync,
  sessionId: string,
): Liveness {
  const row = database
    .prepare(
      "SELECT status, termination_intent FROM terminal_sessions WHERE id = ?",
    )
    .get(sessionId) as
    | { status: string; termination_intent: string }
    | undefined;
  if (row === undefined) return "gone";
  if (row.status === "running") return "alive";
  return row.termination_intent === "hibernate" ? "sleeping" : "gone";
}

const domains = new WeakMap<CoreServer, TimelineDomain>();

/** 这台 core 装好的时间线域；没装（库没过统一迁移）是 `undefined`。 */
export function timelineDomainOf(
  server: CoreServer,
): TimelineDomain | undefined {
  return domains.get(server);
}

export function install(
  context: CoreContext,
  options: { readonly bootId?: string } = {},
): TimelineDomain | undefined {
  if (!context.db.unified) return undefined;
  const domain = new TimelineDomain(context, options);
  domains.set(context.server, domain);
  installRoutes(context, domain);
  try {
    domain.recoverInterrupted();
    domain.pruneOrphans();
  } catch (error) {
    context.log.warn("could not settle stale timelines", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  context.onStop?.(() => {
    domain.close();
    if (domains.get(context.server) === domain) {
      domains.delete(context.server);
    }
  });
  return domain;
}
