import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";

import {
  type ClientSource,
  type RemoteService,
  remotePasswordChangeable,
} from "../../../../api/remote-services";
import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import { useSource, useSourceStatus } from "../../../../sources";
import { initialOf } from "../../../../sources/workspace-groups";
import { tunnelPill } from "../../RemoteShare";
import { SettingsRow } from "../../SettingsRow";
import { sourcePill } from "../../source-status";
import { PASSWORD_CHANGEABLE_KEY, shortFingerprint } from "./keys";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { StatusPill } from "@/ui/status-pill";

export function RowMenu({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("remote.actions", { name })}>
          <Ellipsis />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[var(--z-dialog)]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 一行中转账号：登录 / 登出、互联网路线（经它让别的设备访问这台电脑）、改口令
 * （中继报能力才有，§63）、重试中继侧清理、移除。路线开着时行上是路线状态。
 */
export function RemoteRow({
  remote,
  pending,
  tunnel,
  inUse = false,
  onSignIn,
  onSignOut,
  onInternet,
  onRetryCleanup,
  onChangePassword,
  onRename,
  onRemove,
}: {
  remote: RemoteService;
  pending: string | null;
  /** 经这个账号的互联网路线状态；没开是 `null`。 */
  tunnel: string | null;
  /** 页面正经这个中转到达这台电脑：登出、移除、停用路线都会自断。 */
  inUse?: boolean;
  onSignIn(): void;
  onSignOut(): void;
  /** 能开路线的账号才给（个人中转、登录着、有账号名）。 */
  onInternet?: (on: boolean) => void;
  onRetryCleanup(): void;
  onChangePassword(): void;
  onRename(): void;
  onRemove(): void;
}) {
  const t = useT();
  const signedIn = remote.hasCredentials && remote.kind === "personal";
  const changeable = useQuery({
    queryKey: [...PASSWORD_CHANGEABLE_KEY, remote.serviceId],
    queryFn: () => remotePasswordChangeable(remote.serviceId),
    enabled: signedIn,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const pill = tunnel === null ? null : tunnelPill(tunnel);
  return (
    <SettingsRow
      label={remote.label}
      footnote={[
        remote.accountHint,
        shortFingerprint(remote.fingerprint),
        inUse ? t("remote.inUse") : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {pill && <StatusPill tone={pill.tone} label={t(pill.key)} />}
      {pending !== null && (
        <StatusPill tone="attention" label={t("remote.relayPending")} />
      )}
      {!remote.hasCredentials && (
        <Button size="sm" variant="secondary" onClick={onSignIn}>
          {t("remote.signIn")}
        </Button>
      )}
      <RowMenu name={remote.label}>
        <DropdownMenuItem onSelect={onRename}>
          {t("services.rename")}
        </DropdownMenuItem>
        {onInternet && (
          <DropdownMenuItem
            disabled={tunnel !== null && inUse}
            onSelect={() => onInternet(tunnel === null)}
          >
            {t(
              tunnel === null
                ? "remote.internet.start"
                : "remote.internet.stop",
            )}
          </DropdownMenuItem>
        )}
        {signedIn && changeable.data === true && (
          <DropdownMenuItem onSelect={onChangePassword}>
            {t("remote.password.change")}
          </DropdownMenuItem>
        )}
        {remote.hasCredentials && (
          <DropdownMenuItem disabled={inUse} onSelect={onSignOut}>
            {t("remote.signOut")}
          </DropdownMenuItem>
        )}
        {pending !== null && (
          <DropdownMenuItem onSelect={onRetryCleanup}>
            {t("remote.relayPending.retry")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={inUse}
          onSelect={onRemove}
        >
          {t("remote.remove")}
        </DropdownMenuItem>
      </RowMenu>
    </SettingsRow>
  );
}

/** 我的另一台电脑：连接状态、改名、断开（忘掉凭据）、移除。 */
export function MineRow({
  source,
  inUse = false,
  onForget,
  onRename,
  onRemove,
  onTraffic,
}: {
  source: ClientSource;
  /** 打开着的工作空间就在它上面：断开、移除都会把它断掉。 */
  inUse?: boolean;
  /** 看这台客户端经中继访问它用了多少流量（直连不计，不给）。 */
  onTraffic?: () => void;
  onForget(): void;
  onRename(): void;
  onRemove(): void;
}) {
  const t = useT();
  const connection = useSource(source.sourceId);
  const status = useSourceStatus(connection);
  const pill = sourcePill(
    source.hasCredentials ? status.state : "unauthorized",
  );
  const where = source.kind === "relayed" ? source.relayOrigin : source.baseUrl;
  return (
    <SettingsRow
      label={source.label}
      footnote={[
        t(
          source.kind === "relayed"
            ? "remote.kind.relayed"
            : "remote.kind.direct",
        ),
        where.replace(/^https?:\/\//, ""),
        inUse ? t("remote.inUse.current") : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <StatusPill tone={pill.tone} label={t(pill.key)} />
      <RowMenu name={source.label}>
        {onTraffic && (
          <DropdownMenuItem onSelect={onTraffic}>
            {t("traffic.title")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onRename}>
          {t("services.rename")}
        </DropdownMenuItem>
        {source.hasCredentials && (
          <DropdownMenuItem disabled={inUse} onSelect={onForget}>
            {t("remote.forget")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={inUse}
          onSelect={onRemove}
        >
          {t("remote.remove")}
        </DropdownMenuItem>
      </RowMenu>
    </SettingsRow>
  );
}

/** 别人分享给我的一台：主人、权限、到期；退出即移除这一行。 */
export function SharedRow({
  source,
  inUse = false,
  onLeave,
  onTraffic,
}: {
  source: ClientSource;
  inUse?: boolean;
  onTraffic?: () => void;
  onLeave(): void;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const connection = useSource(source.sourceId);
  const status = useSourceStatus(connection);
  const pill = sourcePill(
    source.hasCredentials ? status.state : "unauthorized",
  );
  const owner = source.ownerLabel.trim() || source.label;
  const expired =
    source.shareExpiresAtMs > 0 && source.shareExpiresAtMs <= Date.now();
  const facts = [
    source.label !== owner ? source.label : "",
    source.shareExpiresAtMs > 0
      ? t(expired ? "remote.shared.expired" : "remote.shared.until", {
          time: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
          }).format(source.shareExpiresAtMs),
        })
      : "",
    inUse ? t("remote.inUse.current") : "",
  ].filter(Boolean);
  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            size="sm"
            aria-hidden
            className="size-5 data-[size=sm]:size-5"
          >
            <AvatarFallback className="text-caption font-medium">
              {initialOf(owner)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{owner}</span>
        </span>
      }
      {...(facts.length > 0 ? { footnote: facts.join(" · ") } : {})}
    >
      {source.shareRole !== "" && (
        <Badge variant="secondary" size="sm">
          {t(`workspaceGroups.role.${source.shareRole}`)}
        </Badge>
      )}
      <StatusPill tone={pill.tone} label={t(pill.key)} />
      <RowMenu name={owner}>
        {onTraffic && (
          <DropdownMenuItem onSelect={onTraffic}>
            {t("traffic.title")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          disabled={inUse}
          onSelect={onLeave}
        >
          {t("remote.leave")}
        </DropdownMenuItem>
      </RowMenu>
    </SettingsRow>
  );
}
