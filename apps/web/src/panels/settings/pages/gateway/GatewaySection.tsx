import * as React from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useT } from "../../../../app/preferences-store";
import { useAccess } from "../../../../app/use-access";
import { GATEWAY_QUERY_KEY } from "../../../../api/gateway";
import { onIdentitySessionChange } from "../../../../api/identity";
import {
  listIdentityDevices,
  revokeIdentityDevice,
} from "../../../../api/security";
import { GatewayDevices, type GatewayDevice } from "./GatewayDevices";
import { Loadable } from "@/loading/Loadable";
import { TableCardSkeleton } from "../../SettingsLoadable";
import { useOrigins } from "../origins";

const DEVICES_QUERY_KEY = [...GATEWAY_QUERY_KEY, "devices"] as const;

/** 托盘也能开关、地址也会变：开着这一页时隔一会儿重读一次。 */
export const GATEWAY_POLL_MS = 15_000;

/** 这台设备在身份面上的样子（由「设备登录」那一块报上来）。 */
export interface GatewayIdentity {
  deviceId: string;
  /** 会话带 `identity:manage`。 */
  canManage: boolean;
}

/**
 * 已配对设备（设备与会话页）。设备列表要一条身份会话；没有会话时（还没配对的
 * 浏览器）整块不出现。配对成功那一刻会话换了，还在路上的那一次带的是旧凭据，
 * 先取消再重取。
 */
export function GatewayDevicesSection({
  identity = null,
  onCurrentRevoked,
}: {
  identity?: GatewayIdentity | null;
  /** 撤销的正是这台设备：身份会话随之失效。 */
  onCurrentRevoked?(): void;
} = {}) {
  const t = useT();
  const client = useQueryClient();
  const owner = !useAccess().member;
  const devices = useInfiniteQuery({
    queryKey: DEVICES_QUERY_KEY,
    // 带着 `signal`：配对成功时作废重取要能打断还没答的那一次（它可能在会话
    // Cookie 落下之前发出，答 401）。
    queryFn: ({ pageParam, signal }) =>
      listIdentityDevices(pageParam, 50, signal),
    initialPageParam: "",
    getNextPageParam: (page) => (page.hasMore ? page.nextId : undefined),
    retry: false,
  });
  React.useEffect(
    () =>
      onIdentitySessionChange(() => {
        // 只作废的话，还没有数据的查询会沿用那一次的答案（401）。
        void client
          .cancelQueries({ queryKey: DEVICES_QUERY_KEY })
          .then(() =>
            client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY }),
          );
      }),
    [client],
  );

  const [revoking, setRevoking] = React.useState<string | null>(null);
  async function revoke(device: GatewayDevice) {
    setRevoking(device.deviceId);
    try {
      await revokeIdentityDevice(device.deviceId, device.epoch);
      if (device.deviceId === identity?.deviceId) onCurrentRevoked?.();
    } catch {
      toast.error(t("gateway.devices.revokeFailed"));
    } finally {
      setRevoking(null);
      void client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    }
  }

  const list = devices.data?.pages.flatMap((page) => page.devices) ?? null;
  const origins = useOrigins(list?.map((device) => device.principalId) ?? []);
  if (!list && !devices.isLoading) return null;
  return (
    <Loadable
      loading={!list}
      skeleton={
        <TableCardSkeleton rows={3} columns={5} title={t("gateway.devices")} />
      }
    >
      {list && (
        <GatewayDevices
          devices={list}
          revoking={revoking}
          onRevoke={(device) => void revoke(device)}
          currentDeviceId={identity?.deviceId ?? null}
          originOf={origins.label}
          // owner 一定能撤销；成员要会话里带管理权。
          canRevoke={owner || Boolean(identity?.canManage)}
          hasMore={devices.hasNextPage}
          loadingMore={devices.isFetchingNextPage}
          onMore={() => void devices.fetchNextPage()}
        />
      )}
    </Loadable>
  );
}
