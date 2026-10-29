/**
 * 主机级的「需要人处理」（契约 §81.1）：设备背书。App 挂一次。
 *
 * 只有 owner 读得到（`devices.endorsements` 是 `settings:read`）；成员不问。数据在本机 core
 * 上落了库，所以没人看画布时错过的背书，页面打开后照样在铃铛里。即时事件 `devices.endorsed`
 * 到了就重读，别的时候慢慢轮询。
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeviceEndorsement } from "@armadra/shared";

import { ENDORSEMENTS_QUERY_KEY, devicesApi } from "../api/devices";
import { onWorkspaceEvent } from "../api/events";
import { localSource } from "../api/source";
import { useAccess } from "../app/use-access";
import { usePreferencesStore, type useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { NEEDS_POLL_MS } from "./use-human-needs";
import { useNeedsStore } from "./needs-store";

/** 未读的背书通知（owner 才查）；结果进 `useNeedsStore.host`，铃铛与弹窗队列都读那里。 */
function useEndorsements(): DeviceEndorsement[] | undefined {
  const access = useAccess();
  return useQuery({
    queryKey: ENDORSEMENTS_QUERY_KEY,
    queryFn: devicesApi.endorsements,
    enabled: !access.member,
    retry: false,
    refetchInterval: NEEDS_POLL_MS,
  }).data;
}

export function useHostNeedsSync(): void {
  const client = useQueryClient();
  const endorsements = useEndorsements();
  useEffect(
    () =>
      onWorkspaceEvent(
        "devices.endorsed",
        (_event, sourceId) => {
          if (sourceId === localSource.sourceId)
            void client.invalidateQueries({ queryKey: ENDORSEMENTS_QUERY_KEY });
        },
        { allSources: true },
      ),
    [client],
  );
  useEffect(() => {
    if (endorsements !== undefined)
      useNeedsStore.getState().setHost(endorsements);
  }, [endorsements]);
}

/**
 * 标已读并从清单里拿掉（铃铛立刻少一条，下一次重读与库里一致）。浏览器经中继标不掉
 * （`forbidden`）：清单不动，要在主机本机或主人的原生端标。
 */
export async function markEndorsementsRead(
  ids: readonly string[],
): Promise<void> {
  try {
    await devicesApi.markEndorsementsRead(ids);
  } catch {
    return;
  }
  const store = useNeedsStore.getState();
  store.setHost(store.host.filter((row) => !ids.includes(row.id)));
}

/** 打开设置的「设备」页。 */
export function openDevicesPage(): void {
  usePreferencesStore.getState().setLastSettingsSection("devices");
  useCanvasStore.getState().setPanel("settings", true);
}

/** 「{背书设备} 放行了 {主体} 的 {设备}」：名字是背书那一刻抄下的（契约 §81.1）。 */
export function endorsementText(
  t: ReturnType<typeof useT>,
  item: DeviceEndorsement,
): string {
  return t("e2e.endorsed.title", {
    endorser: item.endorserLabel || item.endorserDeviceId.slice(0, 8),
    principal: item.principalName || item.principalId.slice(0, 8),
    device: item.deviceLabel || "—",
  });
}
