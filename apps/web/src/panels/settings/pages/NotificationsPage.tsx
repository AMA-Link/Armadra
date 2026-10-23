import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { playStatusSound } from "../../../app/notifications";
import { useAccess } from "../../../app/use-access";
import { useRemoteAccess } from "../remote-access";
import { ScopeBadge } from "../scope-badge";
import { PushDevices } from "./PushDevices";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsLoadable } from "../SettingsLoadable";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Button } from "@/ui/button";
import { Slider } from "@/ui/slider";
import { Switch } from "@/ui/switch";

/**
 * 设置 → 通知（§24.1）。
 *
 * 只有「需要人处理」的事会通知（审批、等待回答、出错，契约 §81），一个开关
 * 管系统通知；提示音另有一个开关 + 一个音量。
 *
 * 「更新下载完成」是主机设置（`updates.notify`，从原更新页移来，§2.2）：
 * 行尾一枚作用范围徽标；成员读不到设置文档，远端主机的更新由那台自己的壳
 * 做，这两种情况都不画。
 *
 * 「推送设备」列出登记了推送的设备，逐台改收哪些种类（契约 §74）。
 */
export function NotificationsPage() {
  const t = useT();
  const { member } = useAccess();
  const { remote } = useRemoteAccess();
  const notifyNeedsYou = usePreferencesStore((state) => state.notifyNeedsYou);
  const setNotifyNeedsYou = usePreferencesStore(
    (state) => state.setNotifyNeedsYou,
  );
  const sound = usePreferencesStore((state) => state.sound);
  const setSound = usePreferencesStore((state) => state.setSound);
  const volume = usePreferencesStore((state) => state.soundVolume);
  const setVolume = usePreferencesStore((state) => state.setSoundVolume);

  return (
    <>
      <SettingsPageHeader
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={!sound}
            onClick={() => playStatusSound()}
          >
            {t("settings.preview")}
          </Button>
        }
      />
      <SettingsGroup>
        <SettingsRow label={t("settings.notifyNeedsYou")}>
          <Switch
            checked={notifyNeedsYou}
            aria-label={t("settings.notifyNeedsYou")}
            onCheckedChange={setNotifyNeedsYou}
          />
        </SettingsRow>

        {member || remote ? null : <UpdateNotifyRow />}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.sound")}>
          <Switch
            checked={sound}
            aria-label={t("settings.sound")}
            onCheckedChange={setSound}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.soundVolume")}>
          <Slider
            className="w-[168px]"
            aria-label={t("settings.soundVolume")}
            disabled={!sound}
            min={0}
            max={100}
            step={5}
            value={[volume]}
            onValueChange={([next]) => setVolume(next ?? 0)}
          />
          <span className="w-8 text-right text-caption tabular-nums text-muted-foreground">
            {volume}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <PushDevices />
    </>
  );
}

function UpdateNotifyRow() {
  const t = useT();
  const { settings, save } = useRuntimeSettings({ scope: "local" });
  return (
    <SettingsLoadable loading={settings.isLoading} control="switch">
      <SettingsRow label={t("updates.notify")}>
        <ScopeBadge scope="host" />
        <Switch
          checked={settings.data?.updates?.notify ?? true}
          disabled={!settings.data}
          aria-label={t("updates.notify")}
          onCheckedChange={(next) => save.mutate({ updates: { notify: next } })}
        />
      </SettingsRow>
    </SettingsLoadable>
  );
}
