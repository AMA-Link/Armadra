import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { keyOfSpace, spaceWire, type CloudSpace } from "../space";

/** 主机目录与详情的数据层（云端控制台 §6.2 `hosts` / `host` / `access`），个人与团队空间共用。 */
type Sources = CloudClient["sources"];
export type HostRow = Awaited<ReturnType<Sources["list"]>>["sources"][number];
export type HostDetail = Awaited<ReturnType<Sources["get"]>>;
export type HostAccess = Awaited<
  ReturnType<Sources["accessList"]>
>["access"][number];

export interface HostFilters {
  readonly status?: "online" | "offline" | "revoked";
  readonly q?: string;
}

export const HOST_PAGE = 50;

/** 目录：游标分页，翻筛选时保留上一页内容不闪骨架。`limit` 给概览取前几行。 */
export function useHosts(
  space: CloudSpace,
  filters: HostFilters = {},
  limit = HOST_PAGE,
) {
  const api = useCloudApi();
  const { status, q } = filters;
  return useInfiniteQuery({
    queryKey: cloudKeys.hosts(keyOfSpace(space), { status, q, limit }),
    initialPageParam: undefined as string | undefined,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) =>
      api.client.sources.list({
        space: spaceWire(space),
        limit,
        ...(status ? { status } : {}),
        ...(q ? { q } : {}),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useHost(space: CloudSpace, sourceId: string) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.host(keyOfSpace(space), sourceId),
    queryFn: () => api.client.sources.get({ sourceId }),
  });
}

/** 改名：成功后详情换成新值，目录重拉。 */
export function useRenameHost(space: CloudSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, name }: { sourceId: string; name: string }) =>
      api.client.sources.update({ sourceId, name }),
    onSuccess: (detail) => {
      client.setQueryData(
        cloudKeys.host(keyOfSpace(space), detail.sourceId),
        detail,
      );
      return client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "hosts"],
      });
    },
  });
}

export function useRevokeHost(space: CloudSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.client.sources.revoke({ sourceId }),
    onSuccess: (_result, sourceId) => {
      client.removeQueries({
        queryKey: cloudKeys.host(keyOfSpace(space), sourceId),
      });
      return client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "hosts"],
      });
    },
  });
}

export function useHostAccess(space: CloudSpace, sourceId: string) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.access(keyOfSpace(space), sourceId),
    queryFn: () => api.client.sources.accessList({ sourceId }),
  });
}

export function useRevokeAccess(space: CloudSpace, sourceId: string) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      api.client.sources.accessRevoke({ sourceId, accountId }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: cloudKeys.access(keyOfSpace(space), sourceId),
      }),
  });
}
