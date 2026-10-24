import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";

/** 运营后台的数据层（云端控制台 §6.2 `["cloud","ops",…]`）：全部走运营客户端 `api.ops`。 */

type Admin = CloudClient["admin"];
type DrainInput = Parameters<Admin["relayNodeDrain"]>[0] & { reason?: string };
type Result<K extends keyof Admin> = Awaited<ReturnType<Admin[K]>>;

export type Tenant = Result<"tenants">["tenants"][number];
export type TenantKind = Tenant["kind"];
export type AdminAccount = Result<"account">;
export type AdminTeam = Result<"team">;
export type RelayNode = Result<"relayNodes">["nodes"][number];

/** 第三项事故开关 `rejectNewConnections` 在协议包 0.11.0 才进类型；0.10.0 的包里没有，按 cloud-api §28 手写。升 0.11.0 后删掉这两个类型，直接用包里的。 */
export type Incident = Result<"incident"> & {
  readonly rejectNewConnections?: boolean;
};
export type IncidentPatch = {
  readonly pauseAssertions?: boolean;
  readonly pauseRegistrations?: boolean;
  readonly rejectNewConnections?: boolean;
  readonly reason: string;
};

const NODE_POLL_MS = 15_000;

/** 租户搜索（账号与团队混排）；没有查询词不取。 */
export function useTenants(q: string) {
  const api = useCloudApi();
  return useInfiniteQuery({
    queryKey: cloudKeys.ops("tenants", q),
    enabled: q !== "",
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.ops.admin.tenants({
        q,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** 详情按类型走账号或团队。 */
export function useTenantDetail(kind: TenantKind, id: string) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.ops("tenant", kind, id),
    queryFn: (): Promise<AdminAccount | AdminTeam> =>
      kind === "account"
        ? api.ops.admin.account({ accountId: id })
        : api.ops.admin.team({ teamId: id }),
  });
}

/** 停用 / 恢复（理由必填，写审计）；成功后重取详情与搜索结果。 */
export function useSetTenantStatus() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      id,
      suspended,
      reason,
    }: {
      kind: TenantKind;
      id: string;
      suspended: boolean;
      reason: string;
    }): Promise<unknown> =>
      kind === "account"
        ? api.ops.admin.accountStatus({
            accountId: id,
            status: suspended ? "disabled" : "active",
            reason,
          })
        : api.ops.admin.teamStatus({
            teamId: id,
            status: suspended ? "suspended" : "active",
            reason,
          }),
    onSuccess: () =>
      client
        .invalidateQueries({ queryKey: cloudKeys.ops("tenant") })
        .then(() =>
          client.invalidateQueries({ queryKey: cloudKeys.ops("tenants") }),
        ),
  });
}

/** 节点列表：15 秒轮询，后台标签页不轮询（react-query 缺省）。 */
export function useRelayNodes() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.ops("nodes"),
    queryFn: () => api.ops.admin.relayNodes({}),
    refetchInterval: NODE_POLL_MS,
  });
}

export function useDrainNode() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ node, reason }: { node: string; reason: string }) =>
      // 协议包 0.10.0 的排空入参还没有 `reason`（0.11.0 起有，cloud#121）：放宽入参类型后随体发出。
      api.ops.admin.relayNodeDrain({
        node,
        drain: true,
        reason,
      } as DrainInput),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: cloudKeys.ops("nodes") }),
  });
}

export function useIncident() {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.ops("incident"),
    queryFn: (): Promise<Incident> => api.ops.admin.incident({}),
  });
}

export function useSetIncident() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: IncidentPatch): Promise<Incident> =>
      // 入参类型（0.10.0）没有 rejectNewConnections；线上多出来的字段服务端认。
      api.ops.admin.incidentSet(
        patch as Parameters<Admin["incidentSet"]>[0],
      ) as Promise<Incident>,
    onSuccess: (incident) =>
      client.setQueryData(cloudKeys.ops("incident"), incident),
  });
}
