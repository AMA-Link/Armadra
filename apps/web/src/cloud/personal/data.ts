import { useQuery } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { spacesQuery } from "../api/queries";

/** 个人概览的数据层：计划、用量、待处理（设备信任、收到的邀请）与空间。 */
const PERSONAL = { kind: "personal" } as const;

export type TrustRequest = Awaited<
  ReturnType<CloudClient["trust"]["list"]>
>["requests"][number];
export type ReceivedInvitation = Awaited<
  ReturnType<CloudClient["invitations"]["list"]>
>["invitations"][number];

export function usePlan() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.plan("me"),
    queryFn: () => api.client.billing.plan({ space: PERSONAL }),
  });
}

export function useUsage() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.usage("me"),
    queryFn: () => api.client.billing.usage({ space: PERSONAL }),
  });
}

export function useTrustRequests() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.trust("me"),
    queryFn: () => api.client.trust.list({}),
  });
}

export function useReceivedInvitations() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.invitations("me"),
    queryFn: () => api.client.invitations.list({ box: "received" }),
  });
}

export function useSpaces() {
  const api = useCloudApi();
  return useQuery(spacesQuery(api));
}
