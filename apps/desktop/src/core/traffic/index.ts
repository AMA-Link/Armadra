/**
 * 流量统计域（契约 §76）：经远程服务（中继）收发的字节，按对端 × 类别 × 小时桶。
 *
 *   * `meter.ts`：内存累加器，热路径只做加法；
 *   * `store.ts`：`traffic_buckets`（迁移 0049）的 upsert、查询、保留清理；
 *   * `service.ts`：30 秒 flush、每天按 `traffic.retentionDays` 清旧桶、查询；
 *   * 这里：装配、`traffic.*` 四条 procedure（旧路径 `/api/traffic/*`）。
 *
 * 计量挂在中继域上（`relay/streams.ts` 的流、`relay/client.ts` 的隧道消息），
 * 中继域装配时从 {@link trafficDomain} 取计量器；没装（库没过统一迁移）时中继照常
 * 工作，只是不计。
 */

import {
  TRAFFIC_CLEAR_PATH,
  TRAFFIC_LIVE_PATH,
  TRAFFIC_SERIES_PATH,
  TRAFFIC_SUMMARY_PATH,
  trafficSeriesInputSchema,
  trafficSummaryInputSchema,
} from "@armadra/shared";

import type { CoreRequest, HandlerResult } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreServer } from "../http/server";
import { audit } from "../identity/audit";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { TrafficService, type TrafficServiceOptions } from "./service";

export { TrafficMeter, StreamCounter } from "./meter";
export type { PeerIdentity, TrafficPeer } from "./meter";
export { TrafficService, retentionDaysOf } from "./service";

let assembled: TrafficService | undefined;

/** 这一轮 core 装好的统计域；没装是 `undefined`。 */
export function trafficDomain(): TrafficService | undefined {
  return assembled;
}

/** 测试用：卸下。 */
export function resetTrafficDomain(): void {
  assembled = undefined;
}

/** 设置里的 `traffic.retentionDays`（服务再按取值表收敛）。 */
function currentRetentionDays(): number | undefined {
  const value = settingsDomain()?.settings.get("traffic.retentionDays");
  return typeof value === "number" ? value : undefined;
}

/** 旧路径的查询串按契约的入参解析；不合答 400（与门面同一个错误形状）。 */
function fromQuery<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  request: CoreRequest,
): { input: T } | { refusal: HandlerResult } {
  const parsed = schema.safeParse(Object.fromEntries(request.query));
  if (parsed.success) return { input: parsed.data };
  return {
    refusal: {
      status: 400,
      body: { code: "bad_request", message: "查询参数不对" },
    },
  };
}

export function installRoutes(server: CoreServer, service: TrafficService) {
  const clear = () => {
    service.clear();
    audit({ action: "traffic.clear" });
    return { cleared: true as const };
  };
  registerProcedures(server, "traffic", {
    summary: (input) => service.summary(input),
    series: (input) => service.series(input),
    live: () => service.live(),
    clear,
  } satisfies DomainHandlers<"traffic">);

  // 路由表里的同一组路径：RPC 门面没装时的回落，调的是同一份实现。
  server.router.handle("GET", TRAFFIC_SUMMARY_PATH, (_match, request) => {
    const parsed = fromQuery(trafficSummaryInputSchema, request);
    if ("refusal" in parsed) return parsed.refusal;
    return { status: 200, body: service.summary(parsed.input) };
  });
  server.router.handle("GET", TRAFFIC_SERIES_PATH, (_match, request) => {
    const parsed = fromQuery(trafficSeriesInputSchema, request);
    if ("refusal" in parsed) return parsed.refusal;
    return { status: 200, body: service.series(parsed.input) };
  });
  server.router.handle("GET", TRAFFIC_LIVE_PATH, () => ({
    status: 200,
    body: service.live(),
  }));
  server.router.handle("POST", TRAFFIC_CLEAR_PATH, () => ({
    status: 200,
    body: clear(),
  }));
}

export function install(
  context: CoreContext,
  overrides: Partial<TrafficServiceOptions> = {},
): TrafficService | undefined {
  if (!context.db.unified) return undefined;
  const service = new TrafficService({
    database: context.db.database,
    retentionDays: () => currentRetentionDays() ?? 0,
    log: context.log,
    ...overrides,
  });
  installRoutes(context.server, service);
  context.onStop?.(() => {
    service.close();
    if (assembled === service) assembled = undefined;
  });
  assembled = service;
  return service;
}
