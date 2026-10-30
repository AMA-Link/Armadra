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
  enabled = true,
) {
  const api = useCloudApi();
  const { status, q } = filters;
  return useInfiniteQuery({
    queryKey: cloudKeys.hosts(keyOfSpace(space), { status, q, limit }),
    initialPageParam: undefined as string | undefined,
    enabled,
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

export function useHost(space: CloudSpace, sourceId: string, enabled = true) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.host(keyOfSpace(space), sourceId),
    enabled,
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

export function useHostAccess(
  space: CloudSpace,
  sourceId: string,
  enabled = true,
) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.access(keyOfSpace(space), sourceId),
    enabled,
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

/** 有效权限的四档（与授予的 `role` 同一组值）。 */
const MY_ROLES = ["viewer", "editor", "operator", "driver"] as const;
type MyRole = (typeof MY_ROLES)[number];

/**
 * 本人对这台主机的权限（目录第二行「所有者 · 我的权限」，云端控制台 §3.3.4）：
 * `owner` 是本人登记的；`none` 是看得到但没有有效权限（如团队 admin 看没授予覆盖的主机）；
 * `role` 是合成后的最高权限。答 `null` = 不显示（服务端没报这个字段：旧服务端、个人空间、链接访客）。
 */
export type MyAccess =
  | { readonly kind: "owner" }
  | { readonly kind: "none" }
  | { readonly kind: "role"; readonly role: MyRole };

/**
 * 读 `sourceSummary.myRole`（armadra-cloud#162；`sources.list` / `sources.get` /
 * `sources.update` / `me.sources` 都带，`grantRole | null`，可缺省）。依赖里的协议包
 * （`tools/vendor/armadra-platform-protocol-0.10.0.tgz`）还没有这个字段，这里按可选字段手读：
 * 随协议包 0.11 发布后改为从包里取（`HostRow["myRole"]`），删掉手读与 mock 的放宽。
 * 所有者不看 `myRole`（云端给所有者报 driver）；认不出的值当没报。
 */
export function myAccessOf(host: { readonly owner: boolean }): MyAccess | null {
  const myRole = (host as { readonly myRole?: unknown }).myRole;
  if (myRole === undefined) return null;
  if (host.owner) return { kind: "owner" };
  if (myRole === null) return { kind: "none" };
  return MY_ROLES.some((role) => role === myRole)
    ? { kind: "role", role: myRole as MyRole }
    : null;
}

/** {@link MyAccess} 的文案：所有者与四档权限复用现有的「所有者」与 `workspaceGroups.role.*`。 */
export function myAccessLabel(
  t: (key: string) => string,
  host: { readonly owner: boolean },
): string | null {
  const access = myAccessOf(host);
  if (access === null) return null;
  if (access.kind === "owner") return t("cloud.hosts.owner");
  if (access.kind === "none") return t("cloud.hosts.myAccessNone");
  return t(`workspaceGroups.role.${access.role}`);
}
