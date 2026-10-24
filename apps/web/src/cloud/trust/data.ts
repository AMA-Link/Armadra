import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import { cloudKeys } from "../api/keys";
import { keyOfSpace, spaceWire, type CloudSpace } from "../space";
import { pendingIdOf, useEndorser, type TrustRequest } from "./endorser";

/** 待信任的新设备（云端控制台 §6.2 `trust`）：列表不含校验码；`deviceTrustRequested` / `Resolved` 让它过期。 */
export function useTrustRequests(space: CloudSpace) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.trust(keyOfSpace(space)),
    queryFn: () => api.client.trust.list({ space: spaceWire(space) }),
  });
}

/** 判定结果缓存多久：每次进页面都去开端到端通道太贵。 */
const PROBE_STALE_MS = 5 * 60_000;

export const endorseKey = (space: CloudSpace, sourceId: string) =>
  cloudKeys.endorse(keyOfSpace(space), sourceId);

const refusedKey = (space: CloudSpace, requestId: string) =>
  cloudKeys.endorseRefused(keyOfSpace(space), requestId);

/**
 * 本浏览器能不能背书这条请求（决定行上是「信任」还是「在已信任的设备上处理」）。
 * 没有端到端实现，或请求不带 core 的 `pendingId`，恒为 `false`；键不挂在 `trust` 之下（事件只让列表过期，
 * 免得判定与事件互相引发）；结果缓存 5 分钟，不随窗口聚焦重判。
 */
export function useCanEndorse(space: CloudSpace, request: TrustRequest) {
  const endorser = useEndorser();
  const known = pendingIdOf(request) !== undefined;
  const enabled = endorser !== null && known;
  const probe = useQuery({
    queryKey: endorseKey(space, request.sourceId),
    enabled,
    retry: false,
    staleTime: PROBE_STALE_MS,
    refetchOnWindowFocus: false,
    // 通道一时开不了（离线、通道失败）会抛：不缓存，下次进页面再试；这一行先按不可背书画。
    queryFn: () =>
      (endorser as NonNullable<typeof endorser>).canEndorse(request.sourceId),
  });
  const refused = useQuery({
    queryKey: refusedKey(space, request.requestId),
    enabled: false,
    initialData: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return {
    pending: enabled && probe.isPending,
    trusted: enabled && probe.data === true && refused.data !== true,
  };
}

/**
 * 主机对这一条请求答了 `forbidden`（背书人的角色、授予或团队不够，契约 §60.4）：按请求号记
 * 「不可背书」。只此一条——同一台主机上别的请求的条件各不相同，不跟着变；重新判定「是不是受信
 * 设备」多半仍是「是」，所以不靠作废重判。
 */
export function useRefuseRequest(space: CloudSpace) {
  const client = useQueryClient();
  return (requestId: string) =>
    client.setQueryData(refusedKey(space, requestId), true);
}

/** 拒绝：只告诉云端这条请求作废（不带任何校验码）。 */
export function useRejectTrust(space: CloudSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => api.client.trust.reject({ requestId }),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: cloudKeys.trust(keyOfSpace(space)),
      }),
  });
}

/**
 * 经端到端通道在主机侧背书；成功后请求列表过期。校验码只经函数参数传递：不放进
 * `useMutation` 的变量（会留在 MutationCache 里），也不写日志、地址或本地存储。
 */
export function useApproveTrust(space: CloudSpace) {
  const endorser = useEndorser();
  const client = useQueryClient();
  return async (request: TrustRequest, sas: string): Promise<void> => {
    const pendingId = pendingIdOf(request);
    if (endorser === null || pendingId === undefined)
      throw Object.assign(new Error("device_untrusted"), {
        code: "device_untrusted",
      });
    await endorser.approve({ ...request, pendingId }, sas);
    await client.invalidateQueries({
      queryKey: cloudKeys.trust(keyOfSpace(space)),
    });
  };
}
