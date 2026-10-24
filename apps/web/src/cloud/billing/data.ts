import { useQuery } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { keyOfSpace, spaceWire, type CloudSpace } from "../space";

/** 计划与用量的数据层（云端控制台 §6.2 `plan` / `usage`）；`planChanged` 让两者过期。 */
export type BillingPlan = Awaited<ReturnType<CloudClient["billing"]["plan"]>>;
export type BillingUsage = Awaited<ReturnType<CloudClient["billing"]["usage"]>>;
export type UsageEntry = BillingUsage["usage"][number];

export function usePlan(space: CloudSpace) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.plan(keyOfSpace(space)),
    queryFn: () => api.client.billing.plan({ space: spaceWire(space) }),
  });
}

/** 本计费周期的各项用量，按天的流量序列一并取（`granularity: "day"`）。 */
export function useBillingUsage(space: CloudSpace) {
  const api = useCloudApi();
  return useQuery({
    queryKey: [...cloudKeys.usage(keyOfSpace(space)), "billing"] as const,
    queryFn: () =>
      api.client.billing.usage({
        space: spaceWire(space),
        granularity: "day",
      }),
  });
}
