import { useT } from "../../../../app/preferences-store";
import type { HostSpace } from "../../../../api/remote-services";
import { Button } from "@/ui/button";
import { DropdownMenuItem } from "@/ui/dropdown-menu";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import { SettingsRow } from "../../SettingsRow";
import { tunnelPill } from "../../RemoteShare";
import { RowMenu } from "./rows";

/** 「互联网访问」这一行现在的样子。 */
export type InternetState =
  /** 本机登记在 Armadra 云；`space` 读不到时只写云的名字。 */
  | {
      readonly kind: "cloud";
      readonly space: HostSpace | null;
      readonly tunnel: string | null;
    }
  /** 经个人中转（或只用令牌登记）开着。 */
  | {
      readonly kind: "relay";
      readonly label: string;
      readonly tunnel: string | null;
    }
  /** 没开：`cloud` 登录 / 登记 Armadra 云，`relay` 一键开个人中转。 */
  | { readonly kind: "off"; readonly via: "cloud" | "relay" };

/**
 * 设置 → 远程访问 → 这台电脑 →「互联网访问」（#675）：开关开着时的第二行，取代
 * 以前的「可达范围」下拉。登记到 Armadra 云即互联网可达，行上是「Armadra 云 · 空间」
 * 与「更换」；没开是一个「登录 Armadra 云」按钮（只有个人中转账号的人是「启用互联网路线」）。
 * 停用在行末的菜单里。
 */
export function InternetRow({
  state,
  busy = false,
  locked = false,
  onSignIn,
  onChange,
  onStop,
}: {
  state: InternetState;
  busy?: boolean;
  /** 页面正经这条路线到达这台电脑：更换、停用都会自断。 */
  locked?: boolean;
  /** 没开时的按钮：登录 / 登记 Armadra 云，或一键开个人中转。 */
  onSignIn(): void;
  onChange(): void;
  onStop(): void;
}) {
  const t = useT();
  const label = t("remote.internet");
  if (state.kind === "off") {
    return (
      <SettingsRow label={label}>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onSignIn}
        >
          {busy && <Spinner data-icon="inline-start" aria-hidden />}
          {t(
            state.via === "cloud"
              ? "remote.cloud.signIn"
              : "remote.internet.start",
          )}
        </Button>
      </SettingsRow>
    );
  }
  const pill = state.tunnel === null ? null : tunnelPill(state.tunnel);
  const space =
    state.kind === "cloud" && state.space !== null
      ? state.space.kind === "personal"
        ? t("remote.cloud.space.personal")
        : state.space.name
      : "";
  const name =
    state.kind === "cloud"
      ? [t("remote.cloud.name"), space].filter(Boolean).join(" · ")
      : state.label;
  return (
    <SettingsRow label={label}>
      <span
        data-slot="internet-route"
        className="min-w-0 truncate text-body text-muted-foreground"
      >
        {name}
      </span>
      {pill && <StatusPill tone={pill.tone} label={t(pill.key)} />}
      {state.kind === "cloud" && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || locked}
          onClick={onChange}
        >
          {t("remote.cloud.change")}
        </Button>
      )}
      <RowMenu name={label}>
        <DropdownMenuItem disabled={busy || locked} onSelect={onStop}>
          {t("remote.internet.stop")}
        </DropdownMenuItem>
      </RowMenu>
    </SettingsRow>
  );
}
