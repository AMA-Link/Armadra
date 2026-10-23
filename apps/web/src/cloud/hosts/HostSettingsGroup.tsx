import { useT } from "@/app/preferences-store";
import { CLOUD_ROLES } from "@/lib/cloud-grant";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import type { CloudSpace } from "../space";
import { useUpdateHostSettings, type HostSettings } from "./grants-data";

const SIGNERS = [
  ["owner", "cloud.hosts.signersOwner"],
  ["owner_admin", "cloud.hosts.signersAdmins"],
  ["driver", "cloud.hosts.signersDrivers"],
] as const;

/**
 * 团队主机的设置（云端控制台 §3.3.5）：谁可以创建链接、允许访客、缺省角色。改动即存，
 * 乐观更新，失败回滚并提示（§6.2）。
 */
export function HostSettingsGroup({
  space,
  sourceId,
  settings,
}: {
  space: CloudSpace;
  sourceId: string;
  settings: HostSettings;
}) {
  const t = useT();
  const update = useUpdateHostSettings(space);
  const save = (patch: Partial<HostSettings>) =>
    update.mutate(
      { sourceId, settings: patch },
      {
        onSuccess: () => toast.success(t("cloud.common.saved")),
        onError: (failure) => toast.error(describeFailure(failure)),
      },
    );
  return (
    <SettingsGroup>
      <SettingsRow label={t("cloud.hosts.linkSigners")}>
        <Select
          value={settings.linkCreators}
          onValueChange={(next) =>
            save({ linkCreators: next as HostSettings["linkCreators"] })
          }
        >
          <SelectTrigger
            size="sm"
            className="w-52"
            aria-label={t("cloud.hosts.linkSigners")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {SIGNERS.map(([value, key]) => (
              <SelectItem key={value} value={value}>
                {t(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label={t("cloud.hosts.allowGuests")}>
        <Switch
          aria-label={t("cloud.hosts.allowGuests")}
          checked={settings.allowGuests}
          onCheckedChange={(checked) => save({ allowGuests: checked })}
        />
      </SettingsRow>
      <SettingsRow label={t("cloud.hosts.defaultRole")}>
        <Select
          value={settings.defaultRole}
          onValueChange={(next) =>
            save({ defaultRole: next as HostSettings["defaultRole"] })
          }
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            aria-label={t("cloud.hosts.defaultRole")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {CLOUD_ROLES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(`workspaceGroups.role.${entry}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  );
}
