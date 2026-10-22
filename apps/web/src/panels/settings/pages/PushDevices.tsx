import { Loadable } from "@/loading/Loadable";
import { SkeletonList } from "@/ui/skeletons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  PUSH_PREFERENCE_KINDS,
  type PushDevice,
  type PushPreferenceKind,
} from "@armadra/shared";

import { pushApi } from "../../../api/push";
import { pinLocal } from "../../../api/source";
import { useT } from "../../../app/preferences-store";
import { toggledKinds, visiblePushKinds } from "../../../push/kinds";
import { lk } from "../local-key";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import { Badge } from "@/ui/badge";
import { Switch } from "@/ui/switch";

/** 设置页恒指本机 core（重设计 B4）。 */
const localPush = pinLocal(pushApi);

export const PUSH_DEVICES_KEY = lk("push", "devices");

type DeviceList = { devices: PushDevice[] };

/**
 * 设置 → 通知 → 推送设备（契约 §27.1、§74）：每台登记了推送的设备一行，展开
 * 是每个种类一个开关。能不能改看 core 给的 `editable`——owner 能改自己名下的
 * 每一台，成员的设备只列不改。没有设备时整组不画。
 */
export function PushDevices() {
  const t = useT();
  const client = useQueryClient();
  const list = useQuery({
    queryKey: PUSH_DEVICES_KEY,
    queryFn: () => localPush.devices(),
  });
  const save = useMutation({
    mutationFn: ({
      deviceId,
      kinds,
    }: {
      deviceId: string;
      kinds: PushPreferenceKind[];
    }) => localPush.setKinds(deviceId, kinds),
    onMutate: async ({ deviceId, kinds }) => {
      await client.cancelQueries({ queryKey: PUSH_DEVICES_KEY });
      const previous = client.getQueryData<DeviceList>(PUSH_DEVICES_KEY);
      client.setQueryData<DeviceList>(PUSH_DEVICES_KEY, (data) =>
        data
          ? {
              devices: data.devices.map((device) =>
                device.deviceId === deviceId ? { ...device, kinds } : device,
              ),
            }
          : data,
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        client.setQueryData(PUSH_DEVICES_KEY, context.previous);
      }
      toast.error(t("push.kinds.failed"));
    },
    onSettled: () => client.invalidateQueries({ queryKey: PUSH_DEVICES_KEY }),
  });

  const devices = list.data?.devices ?? [];
  if (devices.length === 0 && !list.isLoading) return null;
  const shown = visiblePushKinds();

  return (
    <Loadable
      loading={list.isLoading}
      skeleton={
        <SettingsGroup title={t("push.devices.title")}>
          <SkeletonList
            rows={1}
            label={t("state.loading")}
            rowClassName="h-11 px-4"
          />
        </SettingsGroup>
      }
    >
      <SettingsGroup title={t("push.devices.title")}>
        <Accordion type="multiple" className="px-4">
          {devices.map((device) => {
            const kinds = device.kinds ?? PUSH_PREFERENCE_KINDS;
            const editable = device.editable === true;
            const name =
              device.deviceName ?? t(`push.platform.${device.platform}`);
            return (
              <AccordionItem
                key={device.deviceId}
                value={device.deviceId}
                data-push-device={device.deviceId}
              >
                <AccordionTrigger className="items-center gap-3 py-3 font-normal hover:no-underline">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] text-foreground">
                      {name}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t(`push.platform.${device.platform}`)}
                    </span>
                    {device.current && (
                      <Badge
                        variant="secondary"
                        className="h-5 px-1.5 text-[11px]"
                      >
                        {t("push.device.current")}
                      </Badge>
                    )}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="-mx-4">
                  {shown.map((kind) => (
                    <SettingsRow key={kind} label={t(`push.kind.${kind}`)}>
                      <Switch
                        checked={kinds.includes(kind)}
                        disabled={!editable}
                        aria-label={`${name} · ${t(`push.kind.${kind}`)}`}
                        onCheckedChange={(on) =>
                          save.mutate({
                            deviceId: device.deviceId,
                            kinds: toggledKinds(kinds, kind, on),
                          })
                        }
                      />
                    </SettingsRow>
                  ))}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </SettingsGroup>
    </Loadable>
  );
}
