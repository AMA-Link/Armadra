import { useT } from "../../app/preferences-store";
import { useCurrentSource } from "../../sources/context";
import { useLocalName } from "./pages/remote-access/keys";
import { useRemoteAccess } from "./remote-access";
import type { SettingsScope } from "./nav";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/cn";

/**
 * 作用范围的文案（§2.3）。设置恒指本机（#301）：主机与账号页写「本机 · <电脑名>」；
 * 页面的本机源在别处（手机、经 Gateway 打开的网页）时写「主机 · <电脑名>」。
 * 只有「当前工作空间」页（`followsWorkspace`）跟随打开的工作空间，打开的是别的
 * 电脑时写那台的名字。
 */
export function useScopeLabel(
  scope: SettingsScope,
  pinnedLocal = false,
  followsWorkspace = false,
): string {
  const t = useT();
  const { remote } = useRemoteAccess();
  const current = useCurrentSource().descriptor;
  const local = useLocalName();
  if (scope === "device" && !pinnedLocal) return t("settings.scope.device");
  if (followsWorkspace && current.kind !== "local") {
    const name = current.label.trim();
    return name === ""
      ? t("settings.scope.host")
      : t("settings.scope.hostNamed", { name });
  }
  if (scope === "account")
    return remote && local !== ""
      ? t("settings.scope.accountNamed", { name: local })
      : t("settings.scope.account");
  if (local === "")
    return remote ? t("settings.scope.host") : t("settings.scope.local");
  return t(remote ? "settings.scope.hostNamed" : "settings.scope.localNamed", {
    name: local,
  });
}

/**
 * 一枚不可点的作用范围徽标。页头一枚说整页；页内个别行与页不同时，行尾
 * 再放一枚同样式的小徽标（与 `LocalSourceBadge` 同一位置）。
 *
 * 设置就在这台电脑上改时，范围不言自明，徽标不画；只有页面在别处（手机、经
 * Gateway 打开的网页）或打开的是别的电脑的工作空间时才有话要说。
 */
export function ScopeBadge({
  scope,
  pinnedLocal,
  followsWorkspace,
  className,
}: {
  scope: SettingsScope;
  pinnedLocal?: boolean;
  followsWorkspace?: boolean;
  className?: string;
}) {
  const label = useScopeLabel(scope, pinnedLocal, followsWorkspace);
  const { remote } = useRemoteAccess();
  const current = useCurrentSource().descriptor;
  const away = remote || (followsWorkspace && current.kind !== "local");
  if (!away) return null;
  return (
    <Badge
      variant="outline"
      data-settings-scope={pinnedLocal ? "local" : scope}
      className={cn(
        "max-w-48 shrink-0 font-normal text-muted-foreground",
        className,
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}
