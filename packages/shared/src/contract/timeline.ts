import { z } from "zod";

import {
  timelinePageResultSchema,
  timelineSnapshotSchema,
  timelineSyncResultSchema,
} from "../domain/timeline.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `timeline.*`（契约「会话时间线」，设计 docs/armadra/plans/acp-progressive-view.md §6）：
 * 一条会话的统一时间线——ACP 流、终端 CLI 的转录与 hook 归一成同一种条目，由 core
 * 唯一写入，各端按「快照 + 序号之后的增量」同步。
 *
 * 时间线以会话行 id（`terminal_sessions.id`）为键；权限同 `terminal:read`，授权按
 * 会话行查出画布再判（与 `acp.log` 同一道门），所以这里不声明 `workspaceKey`。
 * 内容含思考与转录副本，沿用会话分享的范围（契约 §79），不进推送正文。
 *
 * 实时帧不在这里：`timeline.delta` 与 `timeline.activity` 是工作空间事件流里的
 * 短时事件（不进 outbox），形状是 `domain/timeline.ts` 的 `timelineDeltaSchema` 与
 * `timelineActivityEventSchema`，事件类型由 core 实现一批登记。
 *
 * 节号与 `since` 在合并时取 main 的下一个号（节号见 {@link TIMELINE_CONTRACT_SECTION}，
 * 协议 minor 见 {@link TIMELINE_CONTRACT_SINCE}），不预占。
 */

/** 契约节号；合并时按 main 的下一个号改这一处，再改文档与引用。 */
export const TIMELINE_CONTRACT_SECTION = "§82.1" as const;
/** 首次出现的协议版本（`major.minor`）；随 core 那一批的协议 minor 一起改。 */
export const TIMELINE_CONTRACT_SINCE = "1.48" as const;

const base = {
  since: TIMELINE_CONTRACT_SINCE,
  contract: TIMELINE_CONTRACT_SECTION,
  scope: "terminal:read",
} as const;

const timelineRef = z.object({ timelineId: z.string().min(1) });

/** 一个 blob 的内容：base64 放在 JSON 里，二进制另有 HTTP 路径。 */
export const timelineBlobWireSchema = z.object({
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  /** base64；单个 blob 上限 8 MiB（设计 §3.2）。 */
  data: z.string(),
});

export const timeline = {
  /**
   * 打开：尾部 `tailTurns`（缺省 3）个回合的完整条目 + 全部回合的索引 + 头部值 +
   * 当前活动。页面先订阅事件并缓存 `timeline.*` 帧，再调它，`to <= headSeq` 的帧丢掉。
   */
  open: oc
    .input(
      timelineRef.extend({
        tailTurns: z.number().int().min(1).max(50).optional(),
      }),
    )
    .output(timelineSnapshotSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(meta({ ...base })),
  /**
   * 增量同步：`rev > after` 的全部条目（完整值，含墓碑）+ 头部值（变了才带）+
   * `headSeq`。库里存的是最新值，任何游标一次补齐。`after` 超过 `headSeq`
   * （库回退过）答 `cursor_ahead`，页面改为重新 `open`。
   */
  sync: oc
    .input(timelineRef.extend({ after: z.number().int().nonnegative() }))
    .output(timelineSyncResultSchema)
    .errors(
      errors.pick("bad_request", "forbidden", "not_found", "cursor_ahead"),
    )
    .meta(meta({ ...base })),
  /**
   * 翻页：`beforeTurn` 之前的 `turns`（缺省 5）个回合的完整条目，滚到顶部附近时取。
   */
  page: oc
    .input(
      timelineRef.extend({
        beforeTurn: z.number().int().nonnegative(),
        turns: z.number().int().min(1).max(20).optional(),
      }),
    )
    .output(timelinePageResultSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(meta({ ...base })),
  /**
   * 取一个 blob（图片、音频、内嵌资源）。二进制另有
   * `GET /api/timelines/{timelineId}/blobs/{blobId}`，经控制面 / 中转时走这条。
   */
  blob: oc
    .input(timelineRef.extend({ blobId: z.string().min(1).max(128) }))
    .output(timelineBlobWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(meta({ ...base })),
};
