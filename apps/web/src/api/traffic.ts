import type {
  TrafficLive,
  TrafficSummary,
  TrafficSummaryInput,
} from "@armadra/shared";

import { localClient } from "./client";

/**
 * 这台电脑经远程服务（中继）收发的流量（契约 §76）。远程访问页固定操作本机
 * core，所以只问本机。
 */

export const TRAFFIC_QUERY_KEY = ["traffic"] as const;

export function trafficSummary(
  input: TrafficSummaryInput,
): Promise<TrafficSummary> {
  return localClient().traffic.summary(input);
}

export function trafficLive(): Promise<TrafficLive> {
  return localClient().traffic.live({});
}

export async function clearTraffic(): Promise<void> {
  await localClient().traffic.clear({});
}
