import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import { cloudKeys } from "../api/keys";
import { keyOfSpace, spaceWire, type CloudSpace } from "../space";
import { useEndorser, type TrustRequest } from "./endorser";

/** 待信任的新设备（云端控制台 §6.2 `trust`）：列表不含校验码；`deviceTrustRequested` / `Resolved` 让它过期。 */
export function useTrustRequests(space: CloudSpace) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.trust(keyOfSpace(space)),
    queryFn: () => api.client.trust.list({ space: spaceWire(space) }),
  });
}

/**
 * 本浏览器是不是这台主机的受信设备（决定行上是「信任」还是「在已信任的设备上处理」）。
 * 没有端到端实现时恒为 `false`；键挂在 `trust` 之下，`deviceTrustResolved` 一并重判。
 */
export function useCanEndorse(space: CloudSpace, sourceId: string) {
  const endorser = useEndorser();
  const probe = useQuery({
    queryKey: [...cloudKeys.trust(keyOfSpace(space)), "endorse", sourceId],
    enabled: endorser !== null,
    retry: false,
    queryFn: () =>
      (endorser as NonNullable<typeof endorser>)
        .canEndorse(sourceId)
        .catch(() => false),
  });
  return {
    pending: endorser !== null && probe.isPending,
    trusted: endorser !== null && probe.data === true,
  };
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
    if (endorser === null)
      throw Object.assign(new Error("device_untrusted"), {
        code: "device_untrusted",
      });
    await endorser.approve(request, sas);
    await client.invalidateQueries({
      queryKey: cloudKeys.trust(keyOfSpace(space)),
    });
  };
}
