/**
 * 会话时间线的调用面（契约 §82.1 `timeline.{open,sync,page,blob}`，事件
 * `timeline.delta` / `timeline.activity`，设计 docs/armadra/plans/acp-progressive-view.md §6）。
 *
 * 数据层（`sync.ts`）只认 {@link TimelineTransport}：测试换成假的，就是一个假 core。
 * 默认实现发往指定的源（`clientFor(source)`），事件从工作空间事件流里取。
 * 事件类型由 core 那一批登记进 `WorkspaceEvent`，这里先按形状读，不依赖联合类型。
 */
import {
  timelineActivityEventSchema,
  timelineBlobWireSchema,
  timelineDeltaSchema,
  timelinePageResultSchema,
  timelineSnapshotSchema,
  timelineSyncResultSchema,
  type TimelineActivityEvent,
  type TimelineDelta,
  type TimelinePageResult,
  type TimelineSnapshot,
  type TimelineSyncResult,
} from "@armadra/shared";
import type { z } from "zod";

import { errorCode } from "@/api/client";
import { onWorkspaceConnection, onWorkspaceEvent } from "@/api/events";
import { sourceRegistry } from "@/sources/registry";

export type TimelineBlob = z.infer<typeof timelineBlobWireSchema>;

/** 首屏取的回合数（设计 §2.6、§4）。 */
export const TAIL_TURNS = 3;
/** 向上翻页每次取的回合数（设计 §4）。 */
export const PAGE_TURNS = 5;

export interface TimelineListener {
  delta(event: TimelineDelta): void;
  activity(event: TimelineActivityEvent): void;
  /** 事件流（重新）连上：各活跃时间线补一次 `sync`。 */
  reconnected(): void;
}

export interface TimelineTransport {
  open(timelineId: string, tailTurns?: number): Promise<TimelineSnapshot>;
  sync(timelineId: string, after: number): Promise<TimelineSyncResult>;
  page(
    timelineId: string,
    beforeTurn: number,
    turns?: number,
  ): Promise<TimelinePageResult>;
  blob(timelineId: string, blobId: string): Promise<TimelineBlob>;
  /** 订阅实时帧；返回退订函数。先订阅、再 `open`。 */
  subscribe(listener: TimelineListener): () => void;
}

/** `sync` 的游标超过库里的头（库回退过）：改为整份重新 `open`。 */
export function isCursorAhead(error: unknown): boolean {
  return errorCode(error) === "cursor_ahead";
}

/** 工作空间事件里 `timeline.*` 的宽松形状：登记之前不在 `WorkspaceEvent` 联合里。 */
type LooseSubscribe = (
  type: string,
  handler: (event: unknown, sourceId: string) => void,
  options: { allSources: true },
) => () => void;

/** 发往某个源的传输：RPC 走该源连接的客户端，事件按 `sourceId` 过滤。 */
export function createSourceTransport(sourceId: string): TimelineTransport {
  const client = () => {
    const connection = sourceRegistry().get(sourceId);
    if (connection === undefined) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    return connection.client.timeline;
  };
  return {
    open: async (timelineId, tailTurns = TAIL_TURNS) =>
      timelineSnapshotSchema.parse(
        await client().open({ timelineId, tailTurns }),
      ),
    sync: async (timelineId, after) =>
      timelineSyncResultSchema.parse(
        await client().sync({ timelineId, after }),
      ),
    page: async (timelineId, beforeTurn, turns = PAGE_TURNS) =>
      timelinePageResultSchema.parse(
        await client().page({ timelineId, beforeTurn, turns }),
      ),
    blob: async (timelineId, blobId) =>
      timelineBlobWireSchema.parse(await client().blob({ timelineId, blobId })),
    subscribe(listener) {
      const on = onWorkspaceEvent as unknown as LooseSubscribe;
      const offDelta = on(
        "timeline.delta",
        (event, from) => {
          if (from !== sourceId) return;
          const parsed = timelineDeltaSchema.safeParse(event);
          if (parsed.success) listener.delta(parsed.data);
        },
        { allSources: true },
      );
      const offActivity = on(
        "timeline.activity",
        (event, from) => {
          if (from !== sourceId) return;
          const parsed = timelineActivityEventSchema.safeParse(event);
          if (parsed.success) listener.activity(parsed.data);
        },
        { allSources: true },
      );
      const offConnection = onWorkspaceConnection((_workspace, up, from) => {
        if (up && from === sourceId) listener.reconnected();
      });
      return () => {
        offDelta();
        offActivity();
        offConnection();
      };
    },
  };
}

export type TransportFactory = (sourceId: string) => TimelineTransport;

let factory: TransportFactory = createSourceTransport;
const instances = new Map<string, TimelineTransport>();

/** 某个源的传输（同一个源同一份）。 */
export function timelineTransportFor(sourceId: string): TimelineTransport {
  let transport = instances.get(sourceId);
  if (transport === undefined) {
    transport = factory(sourceId);
    instances.set(sourceId, transport);
  }
  return transport;
}

/** 测试：换传输工厂；不传则复原。 */
export function setTimelineTransportFactory(next?: TransportFactory): void {
  factory = next ?? createSourceTransport;
  instances.clear();
}
