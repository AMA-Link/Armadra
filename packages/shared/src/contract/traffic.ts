import { z } from "zod";

import { TRAFFIC_CATEGORIES } from "../traffic-categories.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `traffic.*`（契约 §76）：这台 core 经远程服务（中继）收发了多少字节。
 *
 * core 在隧道流的边界上计数（明文字节，含 HTTP 头与 WebSocket 帧头），按对端
 * （设备 / 访客链接）× 类别 × UTC 小时桶聚合；通道级的线上字节记在 `transport`
 * 类别。内存累加、每 30 秒批量落库；不记路径、查询串、头、IP 与内容。
 *
 * 只有 owner（全局 `settings:*`）。读不写审计；`clear` 写一条 `traffic.clear`。
 */

const base = { since: "1.44", contract: "§76.1" } as const;

export const TRAFFIC_SUMMARY_PATH = "/api/traffic/summary";
export const TRAFFIC_SERIES_PATH = "/api/traffic/series";
export const TRAFFIC_LIVE_PATH = "/api/traffic/live";
export const TRAFFIC_CLEAR_PATH = "/api/traffic/clear";

/** 保留天数的取值（设置 `traffic.retentionDays`）；缺省 180。 */
export const TRAFFIC_RETENTION_CHOICES = [30, 90, 180, 365, 730] as const;
export const DEFAULT_TRAFFIC_RETENTION_DAYS = 180;

export const trafficCategorySchema = z.enum(TRAFFIC_CATEGORIES);

/**
 * 对端的种类：`device` = 已信任的设备钥（端到端通道之后）；`legacy` = 经断言登录的
 * 会话设备（今天的明文路径）；`guest` = 经分享链接进来的访客；`anonymous` = 还没
 * 认出身份的流（登录、hello、健康探针）；`tunnel` = 隧道本身（只有 `transport`）。
 */
export const trafficPeerKindSchema = z.enum([
  "device",
  "legacy",
  "guest",
  "anonymous",
  "tunnel",
]);

/** 查询串里的数都是字符串：收数也收数字串。 */
const ms = z.coerce.number().int().nonnegative();
const id = z.string().max(256);

export const trafficRowSchema = z.object({
  /** 分组键：`peer` → 对端 id；`category` → 类别；`day` → 那天开始的毫秒（字符串）。 */
  key: z.string(),
  /** 给人看的名字：设备名、访客名或类别；没有时为空串。 */
  label: z.string(),
  /** 只有 `groupBy=peer` 时有意义，其余为空串。 */
  peerKind: z.union([trafficPeerKindSchema, z.literal("")]),
  principalId: z.string(),
  linkId: z.string(),
  streams: z.number().int().nonnegative(),
  /** 对端 → 本机的明文字节。 */
  bytesIn: z.number().int().nonnegative(),
  /** 本机 → 对端的明文字节。 */
  bytesOut: z.number().int().nonnegative(),
  /** 线上字节（`transport` 类别），方向同上。 */
  wireBytesIn: z.number().int().nonnegative(),
  wireBytesOut: z.number().int().nonnegative(),
});

export const trafficSummarySchema = z.object({
  rows: z.array(trafficRowSchema),
  retentionDays: z.number().int().positive(),
});

export const trafficPointSchema = z.object({
  bucketStartMs: z.number().int().nonnegative(),
  streams: z.number().int().nonnegative(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  wireBytesIn: z.number().int().nonnegative(),
  wireBytesOut: z.number().int().nonnegative(),
});

export const trafficSeriesSchema = z.object({
  points: z.array(trafficPointSchema),
});

export const trafficLiveChannelSchema = z.object({
  peerId: z.string(),
  peerKind: trafficPeerKindSchema,
  label: z.string(),
  /** 这个对端当前最早一条还开着的流开始的时刻。 */
  since: z.number().int().nonnegative(),
  streams: z.number().int().nonnegative(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  /** 最近几秒的速率（字节 / 秒）。 */
  rateIn: z.number().nonnegative(),
  rateOut: z.number().nonnegative(),
});

export const trafficLiveSchema = z.object({
  channels: z.array(trafficLiveChannelSchema),
});

const range = {
  fromMs: ms,
  toMs: ms,
  /**
   * 按天分组时本地时区相对 UTC 的分钟数（东八区 `480`）；缺省 0。小时桶本身
   * 都是 UTC 整点，只有「哪天」受它影响。
   */
  utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).optional(),
};

export const trafficSummaryInputSchema = z.object({
  ...range,
  groupBy: z.enum(["peer", "category", "day"]),
  peerId: id.optional(),
  linkId: id.optional(),
});

export const trafficSeriesInputSchema = z.object({
  ...range,
  bucket: z.enum(["hour", "day"]),
  peerId: id.optional(),
  category: trafficCategorySchema.optional(),
});

export type TrafficPeerKind = z.infer<typeof trafficPeerKindSchema>;
export type TrafficRow = z.infer<typeof trafficRowSchema>;
export type TrafficSummary = z.infer<typeof trafficSummarySchema>;
export type TrafficPoint = z.infer<typeof trafficPointSchema>;
export type TrafficSeries = z.infer<typeof trafficSeriesSchema>;
export type TrafficLiveChannel = z.infer<typeof trafficLiveChannelSchema>;
export type TrafficLive = z.infer<typeof trafficLiveSchema>;
export type TrafficSummaryInput = z.infer<typeof trafficSummaryInputSchema>;
export type TrafficSeriesInput = z.infer<typeof trafficSeriesInputSchema>;

const denied = errors.pick("unauthenticated", "forbidden");

export const traffic = {
  /** 一段时间内按对端 / 类别 / 天汇总（§76.1）。 */
  summary: oc
    .input(trafficSummaryInputSchema)
    .output(trafficSummarySchema)
    .errors(errors.pick("bad_request", "unauthenticated", "forbidden"))
    .meta(
      meta({
        ...base,
        scope: "settings:read",
        legacy: { method: "GET", path: TRAFFIC_SUMMARY_PATH },
      }),
    ),
  /** 时间序列（§76.2）：按小时或天的点，没有流量的桶不出现。 */
  series: oc
    .input(trafficSeriesInputSchema)
    .output(trafficSeriesSchema)
    .errors(errors.pick("bad_request", "unauthenticated", "forbidden"))
    .meta(
      meta({
        ...base,
        contract: "§76.2",
        scope: "settings:read",
        legacy: { method: "GET", path: TRAFFIC_SERIES_PATH },
      }),
    ),
  /** 当前开着的流按对端汇总（§76.3），只在内存，不读库。 */
  live: oc
    .input(z.object({}).optional())
    .output(trafficLiveSchema)
    .errors(denied)
    .meta(
      meta({
        ...base,
        contract: "§76.3",
        scope: "settings:read",
        legacy: { method: "GET", path: TRAFFIC_LIVE_PATH },
      }),
    ),
  /** 清空全部统计（§76.4），写审计 `traffic.clear`。 */
  clear: oc
    .input(z.object({}).optional())
    .output(z.object({ cleared: z.literal(true) }))
    .errors(denied)
    .meta(
      meta({
        ...base,
        contract: "§76.4",
        scope: "settings:write",
        legacy: { method: "POST", path: TRAFFIC_CLEAR_PATH },
      }),
    ),
};
