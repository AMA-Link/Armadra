import { useQueries } from "@tanstack/react-query";
import {
  type TrustedDevice,
  trustedDeviceListSchema,
  trustedDeviceSchema,
} from "@armadra/shared";

import {
  type CloudTrustRequest,
  cloudAccess,
  cloudTrustList,
  listSources,
} from "../../api/remote-services";
import { localClient } from "../../api/client";
import { useAccess } from "../../app/use-access";
import { isDesktop } from "../../platform";
import { sourceRegistry } from "../registry";
import { SOURCES_QUERY_KEY } from "../../panels/settings/pages/remote-access/keys";

/** 云端转来的一条待信任请求，带上它来自哪个 Armadra 云账号。 */
export interface TrustItem extends CloudTrustRequest {
  readonly serviceId: string;
}

export const cloudTrustKey = (serviceId: string) =>
  ["cloud-trust", serviceId] as const;

/** 横幅 / 对话框随云端的待信任请求刷新的间隔（云端的实时事件由 me-stream 另给）。 */
const POLL_MS = 30_000;

/**
 * 我能背书的待信任新设备（云端控制台 §3.5.3）。背书只在桌面与原生端做（契约 §60.4）：
 * 浏览器里的页面、服务器壳上的成员不查。每个登录了的 Armadra 云各查一次，云端按
 * 我的角色过滤；请求里没有校验码。
 */
export function useCloudTrust(): { items: TrustItem[] } {
  const member = useAccess().member;
  const enabled = isDesktop() && !member;
  const sources = useQueries({
    queries: [
      {
        queryKey: SOURCES_QUERY_KEY,
        queryFn: listSources,
        retry: false,
        enabled,
      },
    ],
  })[0];
  const services = (sources.data?.remotes ?? []).filter(
    (remote) => remote.kind === "saas" && remote.hasCredentials,
  );
  const results = useQueries({
    queries: services.map((remote) => ({
      queryKey: cloudTrustKey(remote.serviceId),
      queryFn: async () =>
        (await cloudTrustList(remote.serviceId)).requests.map(
          (request): TrustItem => ({ ...request, serviceId: remote.serviceId }),
        ),
      retry: false,
      enabled,
      refetchInterval: POLL_MS,
    })),
  });
  const items = results
    .flatMap((result) => result.data ?? [])
    .sort((a, b) => a.requestedAtMs - b.requestedAtMs);
  return { items };
}

/**
 * 在这台主机上放行那台设备：找到主机上与请求对得上的待确认设备，把背书人输入的校验码
 * 交给主机核对（端到端通道里的 `devices.approve`，契约 §60.4、§80）。校验码只发往
 * 那台主机，从不经云端。
 *
 * 找不到（主机还没有这台设备的申请，或这台电脑够不到那台主机）抛 {@link HostPendingUnavailable}。
 */
export async function approveOnHost(
  item: TrustItem,
  sas: string,
): Promise<TrustedDevice> {
  const client = await hostClient(item);
  if (client === undefined) throw new HostPendingUnavailable();
  const listed = trustedDeviceListSchema.parse(await client.devices.list());
  // 只认精确匹配（设备名 + 成员）：云端的请求没有 pendingId，模糊匹配会把校验码交给
  // 别人的申请。同名多条时让人去主机的设备列表里处理。
  const matches = listed.devices.filter(
    (device) =>
      device.status === "pending" &&
      device.pendingId !== null &&
      device.label === item.device.name &&
      (device.principalName === item.member.displayName ||
        device.principalName === item.member.email),
  );
  if (matches.length > 1) throw new HostPendingAmbiguous();
  const match = matches[0];
  if (match?.pendingId == null) throw new HostPendingUnavailable();
  return trustedDeviceSchema.parse(
    (await client.devices.approve({ pendingId: match.pendingId, sas })).device,
  );
}

/**
 * 请求里的主机是不是本机：与本机登记在这个云上的 id（`cloudAccess().sourceId`）比较，
 * 是就走本机 core；否则按源表找挂载的那台主机。
 */
async function hostClient(item: TrustItem) {
  const local = await cloudAccess(item.serviceId)
    .then((access) => access.sourceId)
    .catch(() => null);
  if (local !== null && local === item.sourceId) return localClient();
  return sourceRegistry().get(item.sourceId)?.client;
}

/** 主机上找不到这台设备的待确认申请，或这台电脑够不到那台主机。 */
export class HostPendingUnavailable extends Error {
  constructor() {
    super("no matching pending device on the host");
    this.name = "HostPendingUnavailable";
  }
}

/** 主机上有不止一条同名同成员的待确认申请：不猜，去主机的设备列表里处理。 */
export class HostPendingAmbiguous extends Error {
  constructor() {
    super("several matching pending devices on the host");
    this.name = "HostPendingAmbiguous";
  }
}
