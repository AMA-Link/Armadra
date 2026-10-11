import { usePreferencesStore, useT } from "../app/preferences-store";
import { SettingsGroup } from "../panels/settings/SettingsGroup";
import { SettingsRow } from "../panels/settings/SettingsRow";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { manageConnections } from "./switcher";

/**
 * 原生 App 设置首页顶部的「连接」一组（#301）：「管理连接」回连接页，另有
 * 「启动时直接进入上次的连接」。换哪台电脑上的工作空间在侧栏点，不在这里切。
 */
export function ConnectionsGroup() {
  const t = useT();
  const autoEnter = usePreferencesStore((state) => state.servicesAutoEnter);
  const setAutoEnter = usePreferencesStore(
    (state) => state.setServicesAutoEnter,
  );
  return (
    <SettingsGroup>
      <SettingsRow label={t("services.connections")}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-action="manage-connections"
          onClick={() => manageConnections()}
        >
          {t("services.manage")}
        </Button>
      </SettingsRow>
      <SettingsRow label={t("services.autoEnter")}>
        <Switch
          checked={autoEnter}
          aria-label={t("services.autoEnter")}
          onCheckedChange={setAutoEnter}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
