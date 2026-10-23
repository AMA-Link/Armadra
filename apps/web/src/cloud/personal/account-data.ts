import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { meQuery } from "../api/queries";

/** 账号页的数据层：资料、口令、邮箱、设备与安全日志。 */
type Me = CloudClient["me"];
export type Device = Awaited<ReturnType<Me["devices"]>>["devices"][number];
export type SecurityEvent = Awaited<
  ReturnType<Me["securityLog"]>
>["events"][number];

export function useMe() {
  const api = useCloudApi();
  return useQuery(meQuery(api));
}

export function useRenameAccount() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (displayName: string) => api.client.me.update({ displayName }),
    onSuccess: (me) => client.setQueryData(cloudKeys.me, me),
  });
}

export function useChangeEmail() {
  const api = useCloudApi();
  return useMutation({
    mutationFn: (input: { newEmail: string; password: string }) =>
      api.client.me.emailChange(input),
  });
}

export function useChangePassword() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { password: string; newPassword: string }) =>
      api.client.auth.changePassword(input),
    // 其他设备被退出：设备列表重拉。
    onSuccess: () => client.invalidateQueries({ queryKey: cloudKeys.devices }),
  });
}

export function useDevices() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.devices,
    queryFn: () => api.client.me.devices({}),
  });
}

/** 退出一台或多台设备（没有批量接口，逐台撤销；失败的留在列表里）。 */
export function useRevokeDevices() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (deviceIds: readonly string[]) => {
      const results = await Promise.allSettled(
        deviceIds.map((deviceId) => api.client.me.deviceRevoke({ deviceId })),
      );
      const failed = results.find((entry) => entry.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
    },
    onSettled: () => client.invalidateQueries({ queryKey: cloudKeys.devices }),
  });
}

const LOG_PAGE = 50;

export function useSecurityLog() {
  const api = useCloudApi();
  return useInfiniteQuery({
    queryKey: cloudKeys.securityLog(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.client.me.securityLog({
        limit: LOG_PAGE,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
