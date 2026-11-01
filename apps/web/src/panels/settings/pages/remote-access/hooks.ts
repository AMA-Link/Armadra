import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";
import type { GatewayConfigPatch, GatewayStatus } from "@armadra/shared";

import {
  GATEWAY_QUERY_KEY,
  gatewayApi,
  notifyShellGatewayChanged,
} from "../../../../api/gateway";
import {
  type RemoteService,
  registeredSpace,
  shareStatus,
  shareThisMachine,
  stopSharing,
} from "../../../../api/remote-services";
import { useT } from "../../../../app/preferences-store";
import { useAccess } from "../../../../app/use-access";
import {
  RELAY_PENDING_KEY,
  SHARE_STATUS_KEY,
  announceStopped,
  shareLinksKey,
} from "../../RemoteShare";
import { GATEWAY_POLL_MS } from "../gateway/GatewaySection";
import { useSourceTable } from "./keys";

/**
 * 局域网那一半（对外服务，契约 §17）：状态与写配置。只有 owner 答，成员连问都
 * 不问；读不到时 `status` 是 `null`。托盘也能开关、地址也会变：开着这一页时隔
 * 一会儿重读一次。
 */
export function useGateway() {
  const t = useT();
  const client = useQueryClient();
  const owner = !useAccess().member;
  const query = useQuery({
    queryKey: GATEWAY_QUERY_KEY,
    queryFn: ({ signal }) => gatewayApi.status(signal),
    refetchInterval: GATEWAY_POLL_MS,
    retry: false,
    enabled: owner,
  });
  const configure = useMutation({
    mutationFn: (patch: GatewayConfigPatch) => gatewayApi.configure(patch),
    onSuccess: (next) => {
      client.setQueryData<GatewayStatus>(GATEWAY_QUERY_KEY, next);
      notifyShellGatewayChanged();
    },
    onError: () => toast.error(t("gateway.saveFailed")),
  });
  return {
    status: owner ? (query.data ?? null) : null,
    loading: owner && query.isPending,
    configure,
  };
}

/**
 * 经它走互联网路线、发分享链接的账号：个人中转要登录着、有账号名（访客行没有）；
 * Armadra 云要本机已登记到它、登录着（设备码登录的会话签链接，契约 §88.4）。
 */
export function canShare(remote: RemoteService): boolean {
  if (remote.guest || !remote.hasCredentials) return false;
  if (remote.kind === "saas") return remote.registered;
  return remote.kind === "personal" && remote.accountHint !== "";
}

/** 能由这一页一键开路线的账号：只有个人中转（Armadra 云的路线就是登记，见 `planRoute`）。 */
export function canStartRoute(remote: RemoteService): boolean {
  return canShare(remote) && remote.kind === "personal";
}

/**
 * 「局域网 + 互联网」该怎么开（#675）。以 Armadra 云为缺省：
 *
 * - `ready`：本机已登记到 Armadra 云，登记就是路线，没有别的要做；
 * - `register`：登录着 Armadra 云、本机没登记：打开「登记到空间」那一步；
 * - `start`：没有可用的云、有个人中转账号：一键开（只有中转账号的人行为不变）；
 * - `signIn`：都没有：打开 Armadra 云设备码登录，`issuer` 是登出了的那一行的地址，
 *   没有这一行是空串（用缺省地址）。
 *
 * 云与个人中转都能用时取云。
 */
export type RoutePlan =
  | { readonly kind: "ready" }
  | { readonly kind: "register"; readonly remote: RemoteService }
  | { readonly kind: "start"; readonly remote: RemoteService }
  | { readonly kind: "signIn"; readonly issuer: string };

export function planRoute(remotes: readonly RemoteService[]): RoutePlan {
  const clouds = remotes.filter(
    (remote) => remote.kind === "saas" && !remote.guest,
  );
  if (clouds.some(canShare)) return { kind: "ready" };
  const signedIn = clouds.find((remote) => remote.hasCredentials);
  if (signedIn !== undefined) return { kind: "register", remote: signedIn };
  const personal = remotes.find(canStartRoute);
  if (personal !== undefined) return { kind: "start", remote: personal };
  return { kind: "signIn", issuer: clouds[0]?.issuer ?? "" };
}

/**
 * 互联网路线：经中转账号或 Armadra 云把这台电脑登记出去（「分享本机」）。任一登记
 * 都算开着；状态跟着 `cloud.tunnel` 事件走（`useTunnelEvents`，挂在页上）。
 */
export function useInternetRoute() {
  const t = useT();
  const client = useQueryClient();
  const table = useSourceTable();
  const status = useQuery({
    queryKey: SHARE_STATUS_KEY,
    queryFn: shareStatus,
    retry: false,
  });
  const remotes = (table.data?.remotes ?? []).filter((remote) => !remote.guest);
  const shareable = remotes.filter(canShare);
  const registrations = status.data?.registrations ?? [];
  const tunnelOf = (issuer: string): string | null =>
    registrations.find((one) => one.issuer === issuer)?.tunnel.state ?? null;
  const localLabel =
    table.data?.sources.find((source) => source.kind === "local")?.label ?? "";

  const refresh = (serviceId?: string) => {
    void client.invalidateQueries({ queryKey: SHARE_STATUS_KEY });
    void client.invalidateQueries({ queryKey: ["sources"] });
    if (serviceId !== undefined)
      void client.invalidateQueries({ queryKey: shareLinksKey(serviceId) });
  };
  const start = useMutation({
    mutationFn: (remote: RemoteService) =>
      shareThisMachine({
        serviceId: remote.serviceId,
        issuer: remote.issuer,
        label: localLabel,
      }),
    onSuccess: (_value, remote) => refresh(remote.serviceId),
    onError: (error: Error) => toast.error(error.message),
  });
  const stop = useMutation({
    mutationFn: async (issuers: readonly string[]) => {
      let pending: string | null = null;
      for (const issuer of issuers)
        pending = (await stopSharing(issuer)) ?? pending;
      return pending;
    },
    onSuccess: (pending) => {
      refresh();
      void client.invalidateQueries({ queryKey: RELAY_PENDING_KEY });
      announceStopped(t, pending);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return {
    remotes,
    shareable,
    startable: shareable.filter(canStartRoute),
    plan: planRoute(remotes),
    registered: shareable.filter((remote) => tunnelOf(remote.issuer) !== null),
    on: registrations.length > 0,
    /**
     * 路线状态：任一登记的隧道（#586）。只用令牌登记、没有登录行的 Armadra 云登记也算，
     * 不只看能分享的账号。
     */
    route:
      registrations.find((one) => one.tunnel.state === "ready")?.tunnel.state ??
      registrations[0]?.tunnel.state ??
      null,
    issuers: registrations.map((one) => one.issuer),
    tunnelOf,
    refresh,
    start,
    stop,
    busy: start.isPending || stop.isPending,
  };
}

/**
 * 本机登记在这个 Armadra 云的哪个空间（`remote` 为 `undefined` 或没登记时不查）。
 * 读不到（云不可达、旧版云不报空间）是 `null`，界面只写云的名字。
 */
export function useRegisteredSpace(remote: RemoteService | undefined) {
  const status = useQuery({
    queryKey: SHARE_STATUS_KEY,
    queryFn: shareStatus,
    retry: false,
  });
  const sourceId = status.data?.sourceId ?? "";
  const serviceId = remote?.serviceId ?? "";
  const query = useQuery({
    queryKey: ["cloud", "space", serviceId, sourceId],
    queryFn: () => registeredSpace(serviceId, sourceId),
    enabled: remote !== undefined && remote.registered && sourceId !== "",
    retry: false,
  });
  return query.data ?? null;
}
