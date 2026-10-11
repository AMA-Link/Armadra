import * as React from "react";
import {
  GATEWAY_LISTEN_CHOICES,
  GATEWAY_TLS_SOURCES,
  type GatewayConfigPatch,
  type GatewayPairingPayload,
  type GatewayStatus,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import { CONTROL_WIDTH } from "../GeneralPage";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";
import { Switch } from "@/ui/switch";
import { PairingCard } from "./PairingCard";

const KNOWN_ERRORS = new Set([
  "acme_misconfigured",
  "acme_port_unavailable",
  "acme_failed",
  "tls_files_missing",
  "port_in_use",
  "port_forbidden",
  "identity_unavailable",
  "gateway_failed",
]);

/** 契约 §17.1 的 `error.code` → 文案键；不认识的码归到「没能开启」。 */
export function gatewayErrorKey(code: string): string {
  return `gateway.error.${KNOWN_ERRORS.has(code) ? code : "gateway_failed"}`;
}

/** 失焦或回车时才提交的输入框；外面的值变了就跟着换。 */
function CommitInput({
  value,
  onCommit,
  label,
  ...rest
}: {
  value: string;
  onCommit(value: string): void;
  label: string;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      {...rest}
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

/** 可达范围：仅局域网，或局域网 + 互联网（经中转账号的互联网路线）。 */
export type Reach = "lan" | "internet";

export interface GatewayPanelProps {
  /** 局域网那一半（对外服务）；读不到（成员、旧版 core）是 `null`。 */
  status: GatewayStatus | null;
  /** 互联网路线开着（任一中转账号登记了这台电脑）。 */
  internet: boolean;
  /** 正在写配置或开关路线。 */
  busy: boolean;
  /** 页面正经这台电脑的对外服务或互联网路线到达：关掉就是自断，不给关。 */
  inUse?: boolean;
  /** 页面正经互联网路线到达：不给退回仅局域网。 */
  internetInUse?: boolean;
  onToggle(on: boolean): void;
  onReach(reach: Reach): void;
  pairing: GatewayPairingPayload | null;
  pairingBusy: boolean;
  onNewPairing(origin?: string): void;
  /** 展示页用：钉住时钟。 */
  now?: number;
}

/**
 * 设置 → 远程访问 → 这台电脑（#301，设计系统 §5.12）：局域网与中转合一。
 *
 * 一个开关「允许其他设备访问这台电脑」，开着时选可达范围：仅局域网（对外服务
 * 监听局域网，无需账号）/ 局域网 + 互联网（再经中转账号开互联网路线）。开着且
 * 对外服务在跑时下面是配对二维码与配对码。端口、证书、监听所有网络在「高级」
 * （{@link GatewayAdvanced}）。服务器壳托管时（`managedBy: shell`）局域网那一半
 * 只读，配对照常。
 */
export function GatewayPanel({
  status,
  internet,
  busy,
  inUse = false,
  internetInUse = false,
  onToggle,
  onReach,
  pairing,
  pairingBusy,
  onNewPairing,
  now,
}: GatewayPanelProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const lan = status?.enabled ?? false;
  const on = lan || internet;
  const shell = status?.managedBy === "shell";
  const starting = status !== null && lan && !status.running && !status.error;
  // ACME 续期失败时旧证书继续服务（契约 §17.1 `tls.acme`）；这里只说发生了
  // 什么与下次什么时候再试，没有失败就什么都不画。
  const acme =
    status !== null && lan && status.running ? status.tls.acme : null;
  const renewFailed = acme ? acme.failures > 0 : false;
  const retryAt = renewFailed && acme?.renewAt ? new Date(acme.renewAt) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SettingsGroup>
        <SettingsRow label={t("remote.allow")}>
          <div className="flex items-center gap-2">
            {busy && <Spinner aria-label={t("remote.allow")} />}
            <Switch
              checked={on}
              disabled={busy || (on && (inUse || (shell && lan)))}
              aria-label={t("remote.allow")}
              onCheckedChange={onToggle}
            />
          </div>
        </SettingsRow>
        {on && (
          <SettingsRow label={t("remote.reach")}>
            <Select
              value={internet ? "internet" : "lan"}
              disabled={busy || (internet && internetInUse)}
              onValueChange={(reach) => onReach(reach as Reach)}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("remote.reach")}
                className="w-[200px] max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                <SelectItem value="lan">{t("remote.reach.lan")}</SelectItem>
                <SelectItem value="internet">
                  {t("remote.reach.internet")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
      </SettingsGroup>

      {status !== null && lan && status.error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t(gatewayErrorKey(status.error.code))}</AlertTitle>
        </Alert>
      )}
      {renewFailed && (
        <Alert variant="destructive" data-slot="gateway-acme-renew-failed">
          <AlertTitle>{t("gateway.acme.renewFailed")}</AlertTitle>
          {retryAt && (
            <AlertDescription className="tabular-nums">
              {t("gateway.acme.retryAt", {
                time: retryAt.toLocaleString(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </AlertDescription>
          )}
        </Alert>
      )}
      {starting && (
        <Alert>
          <Spinner aria-hidden />
          <AlertTitle>{t("gateway.starting")}</AlertTitle>
        </Alert>
      )}
      {status !== null && lan && status.running && (
        <PairingCard
          pairing={pairing}
          busy={pairingBusy}
          origins={status.origins}
          fingerprint={status.tls.fingerprint}
          caHref={
            status.tls.caAvailable && status.origin
              ? `${status.origin}/ca.crt`
              : null
          }
          onNewPairing={onNewPairing}
          now={now}
        />
      )}
    </div>
  );
}

/** 局域网一侧可选的监听：局域网（缺省）或所有网络（公网直连）。 */
const LISTEN_CHOICES = GATEWAY_LISTEN_CHOICES.filter(
  (choice) => choice !== "loopback",
);

/**
 * 「高级」里对外服务的几行：监听、端口、公网来源、证书。对外服务关着时不画。
 */
export function GatewayAdvanced({
  status,
  saving,
  onConfigure,
}: {
  status: GatewayStatus;
  saving: boolean;
  onConfigure(patch: GatewayConfigPatch): void;
}) {
  const t = useT();
  const locked = status.managedBy === "shell" || saving;
  const tlsSource =
    status.tls.source === "selfSigned" ? "localCa" : status.tls.source;
  if (!status.enabled) return null;
  return (
    <>
      <SettingsRow label={t("gateway.listen")}>
        <Select
          value={status.listen}
          disabled={locked}
          onValueChange={(listen) =>
            onConfigure({ listen: listen as GatewayStatus["listen"] })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={t("gateway.listen")}
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {(status.listen === "loopback"
              ? GATEWAY_LISTEN_CHOICES
              : LISTEN_CHOICES
            ).map((choice) => (
              <SelectItem key={choice} value={choice}>
                {t(`gateway.listen.${choice}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label={t("gateway.port")}>
        <CommitInput
          label={t("gateway.port")}
          inputMode="numeric"
          disabled={locked}
          placeholder={t("gateway.port.auto")}
          className={`${CONTROL_WIDTH} h-8 tabular-nums`}
          value={status.port === 0 ? "" : String(status.port)}
          onCommit={(text) => {
            const port = text === "" ? 0 : Number(text);
            if (Number.isInteger(port) && port >= 0 && port <= 65_535)
              onConfigure({ port });
          }}
        />
      </SettingsRow>
      <SettingsRow label={t("gateway.publicOrigin")}>
        <CommitInput
          label={t("gateway.publicOrigin")}
          disabled={locked}
          inputMode="url"
          placeholder="https://armadra.example"
          className="h-8 w-[240px] max-w-full"
          value={status.publicOrigin}
          onCommit={(publicOrigin) => onConfigure({ publicOrigin })}
        />
      </SettingsRow>
      <SettingsRow label={t("gateway.tls")}>
        <Select
          value={tlsSource}
          disabled={locked}
          onValueChange={(source) =>
            onConfigure({
              tls: {
                source: source as (typeof GATEWAY_TLS_SOURCES)[number],
              },
            })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={t("gateway.tls")}
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {GATEWAY_TLS_SOURCES.map((source) => (
              <SelectItem key={source} value={source}>
                {t(`gateway.tls.${source}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {tlsSource === "file" &&
        (["certFile", "keyFile"] as const).map((key) => (
          <SettingsRow key={key} label={t(`gateway.tls.${key}`)}>
            <CommitInput
              label={t(`gateway.tls.${key}`)}
              disabled={locked}
              className="h-8 w-[240px] max-w-full font-mono text-[12px]"
              value={status.tls[key]}
              onCommit={(value) => onConfigure({ tls: { [key]: value } })}
            />
          </SettingsRow>
        ))}
      {tlsSource === "acme" && (
        <SettingsRow label={t("gateway.tls.acmeEmail")}>
          <CommitInput
            label={t("gateway.tls.acmeEmail")}
            disabled={locked}
            type="email"
            className="h-8 w-[240px] max-w-full"
            value={status.tls.acmeEmail}
            onCommit={(acmeEmail) => onConfigure({ tls: { acmeEmail } })}
          />
        </SettingsRow>
      )}
    </>
  );
}
