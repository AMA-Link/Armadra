import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { keyOfSpace, spaceWire, type CloudSpace } from "../space";

/** 授予与有效权限的数据层（云端控制台 §6.2 `grants` / `access`），团队空间的主机详情与授予页共用。 */
type Grants = CloudClient["grants"];
export type Grant = Awaited<ReturnType<Grants["list"]>>["grants"][number];
export type Effective = Awaited<ReturnType<Grants["effective"]>>;
export type EffectiveSource = Effective["from"][number];
export type GrantRole = Grant["role"];
export type GrantSubject = Grant["subject"];
export type HostSettings = NonNullable<
  Awaited<ReturnType<CloudClient["sources"]["get"]>>["settings"]
>;

/** 某台主机上的全部授予（含团队全员）。 */
export function useHostGrants(
  space: CloudSpace,
  sourceId: string,
  enabled = true,
) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.grants(keyOfSpace(space), { sourceId }),
    enabled,
    queryFn: () => api.client.grants.list({ sourceId }),
  });
}

/** 某个人在本人能管的主机上的授予（授予页展开一行时取）。 */
export function useAccountGrants(
  space: CloudSpace,
  accountId: string,
  enabled = true,
) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.grants(keyOfSpace(space), { accountId }),
    enabled,
    queryFn: () => api.client.grants.list({ accountId }),
  });
}

/** 某人对某台主机的有效权限与各来源；展开一行时才取。 */
export function useEffective(
  space: CloudSpace,
  sourceId: string,
  accountId: string,
  enabled = true,
) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.effective(keyOfSpace(space), sourceId, accountId),
    enabled,
    queryFn: () => api.client.grants.effective({ sourceId, accountId }),
  });
}

/** 授予变了：访问清单、有效权限、授予列表都重拉；主机目录里成员能不能看到这台也随之变。 */
function useRefreshGrants(space: CloudSpace) {
  const client = useQueryClient();
  return (sourceId: string) =>
    Promise.all([
      client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "grants"],
      }),
      client.invalidateQueries({
        queryKey: cloudKeys.access(keyOfSpace(space), sourceId),
      }),
      client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "hosts"],
      }),
    ]);
}

export interface GrantInput {
  readonly sourceId: string;
  readonly subject: GrantSubject;
  readonly role: GrantRole;
  readonly workspaceIds?: readonly string[];
  readonly expiresAtMs?: number;
}

export function useCreateGrant(space: CloudSpace) {
  const api = useCloudApi();
  const refresh = useRefreshGrants(space);
  return useMutation({
    mutationFn: ({ workspaceIds, ...input }: GrantInput) =>
      api.client.grants.create({
        ...input,
        ...(workspaceIds ? { workspaceIds: [...workspaceIds] } : {}),
      }),
    onSuccess: (grant) => refresh(grant.sourceId),
  });
}

export interface GrantPatch {
  readonly grantId: string;
  readonly sourceId: string;
  readonly role?: GrantRole;
  readonly workspaceIds?: readonly string[];
  /** `null` = 清除到期（永不到期）；不给 = 不改。 */
  readonly expiresAtMs?: number | null;
}

/** 更新：范围整体替换，到期不改就不传（云端 `grants.update` 的语义）。 */
export function useUpdateGrant(space: CloudSpace) {
  const api = useCloudApi();
  const refresh = useRefreshGrants(space);
  return useMutation({
    mutationFn: ({ sourceId: _sourceId, workspaceIds, ...patch }: GrantPatch) =>
      api.client.grants.update({
        ...patch,
        ...(workspaceIds ? { workspaceIds: [...workspaceIds] } : {}),
      }),
    onSuccess: (_grant, variables) => refresh(variables.sourceId),
  });
}

export function useRevokeGrant(space: CloudSpace) {
  const api = useCloudApi();
  const refresh = useRefreshGrants(space);
  return useMutation({
    mutationFn: ({ grantId }: { grantId: string; sourceId: string }) =>
      api.client.grants.revoke({ grantId }),
    onSuccess: (_result, variables) => refresh(variables.sourceId),
  });
}

/** 撤销某人在这台主机上以他本人为主体的全部授予（`sources.accessRevoke`）。 */
export function useRevokePersonAccess(space: CloudSpace) {
  const api = useCloudApi();
  const refresh = useRefreshGrants(space);
  return useMutation({
    mutationFn: (input: { sourceId: string; accountId: string }) =>
      api.client.sources.accessRevoke(input),
    onSuccess: (_result, variables) => refresh(variables.sourceId),
  });
}

/** 主机设置（谁可以创建链接、允许访客、缺省角色）：乐观更新，失败回滚。 */
export function useUpdateHostSettings(space: CloudSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  const key = (sourceId: string) => cloudKeys.host(keyOfSpace(space), sourceId);
  return useMutation({
    mutationFn: ({
      sourceId,
      settings,
    }: {
      sourceId: string;
      settings: Partial<HostSettings>;
    }) => api.client.sources.update({ sourceId, settings }),
    onMutate: async ({ sourceId, settings }) => {
      await client.cancelQueries({ queryKey: key(sourceId) });
      const before = client.getQueryData<{ settings?: HostSettings }>(
        key(sourceId),
      );
      if (before?.settings)
        client.setQueryData(key(sourceId), {
          ...before,
          settings: { ...before.settings, ...settings },
        });
      return { before };
    },
    onError: (_error, { sourceId }, context) => {
      if (context?.before) client.setQueryData(key(sourceId), context.before);
    },
    onSettled: (_data, _error, { sourceId }) =>
      client.invalidateQueries({ queryKey: key(sourceId) }),
  });
}

/** 取一枚注册令牌（10 分钟有效）：对话框打开时调用，过期后可重新取。 */
export function useRegistrationToken(space: CloudSpace) {
  const api = useCloudApi();
  return useMutation({
    mutationFn: () =>
      api.client.sources.registrationToken({ space: spaceWire(space) }),
  });
}
