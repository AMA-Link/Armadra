import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";

import {
  type ClientSource,
  dismissRelayCleanup,
  forgetSource,
  logoutRemote,
  pendingCode,
  relayPending,
  removeRemote,
  removeSource,
  renameRemote,
  renameSource,
  retryRelayCleanup,
} from "../../../../api/remote-services";
import { useT } from "../../../../app/preferences-store";
import { applySourceTable } from "../../../../sources/bootstrap";
import { useCurrentSource } from "../../../../sources/context";
import { hostedRelay } from "../../../../sources/hosted";
import {
  onJoinIntent,
  openAfterJoin,
  takeJoinLink,
} from "../../../../sources/join-intent";
import { RenameDialog } from "../../../../services/RenameDialog";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { DropdownMenuItem } from "@/ui/dropdown-menu";
import {
  RELAY_PENDING_KEY,
  relayPendingReason,
  useTunnelEvents,
} from "../../RemoteShare";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { sameOrigin, useRemoteAccess } from "../../remote-access";
import { GatewayAdvanced } from "../gateway/GatewayPanel";
import {
  ChangePasswordDialog,
  type PasswordTarget,
} from "../RemotePasswordDialog";
import {
  AddDirectDialog,
  AddRelayDialog,
  JoinLinkDialog,
  MountDialog,
  type RelayDraft,
} from "./dialogs";
import { HostTraffic } from "../../../../traffic/HostTraffic";
import {
  SourceTrafficDialog,
  type SourceTrafficTarget,
} from "../../../../traffic/SourceTrafficDialog";
import { HostAccess } from "./HostAccess";
import { canShare, useGateway, useInternetRoute } from "./hooks";
import { hostOf, useSourceTable, useSourceTableChanged } from "./keys";
import { MineRow, RemoteRow, RowMenu, SharedRow } from "./rows";

const HEADING = "px-0.5 text-[15px] font-semibold text-foreground";

/**
 * 设置 → 远程访问（#301）。固定操作本机 core，两块：
 *
 * - **A 这台电脑**：允许其他设备访问这台电脑（仅局域网 / 局域网 + 互联网）、
 *   配对二维码与配对码、互联网路线上的分享链接（分享唯一的管理处）、中转账号、
 *   流量统计、我的其他电脑（配对另一台、从中转添加）；高级里是监听、端口、证书、另一个中转
 *   账号与中继侧待清理。
 * - **B 他人分享**：别人分享给我的电脑（主人、权限、到期、退出）与「用链接加入」。
 *
 * 中转出错只落在那一行或那一次操作上；错误按 `code` 取文案。
 */
export function RemoteAccessPage() {
  const t = useT();
  const changed = useSourceTableChanged();
  const table = useSourceTable();
  const internet = useInternetRoute();
  const gateway = useGateway();
  const access = useRemoteAccess();
  const currentSourceId = useCurrentSource().descriptor.sourceId;
  useTunnelEvents();

  const [adding, setAdding] = React.useState<RelayDraft | null>(null);
  const [addingDirect, setAddingDirect] = React.useState(false);
  const [mounting, setMounting] = React.useState(false);
  const [traffic, setTraffic] = React.useState<SourceTrafficTarget | null>(
    null,
  );
  // 待填的分享链接（深链、`#join=`）：打开「用链接加入」并预填，人点了才加入。
  const [joining, setJoining] = React.useState<string | null>(takeJoinLink);
  React.useEffect(
    () =>
      onJoinIntent(() => {
        const offered = takeJoinLink();
        if (offered !== null) setJoining(offered);
      }),
    [],
  );
  // 撤销后中继侧没删掉的记录（契约 §31.4）：账号行上标出来，可重试。
  const pending = useQuery({
    queryKey: RELAY_PENDING_KEY,
    queryFn: relayPending,
    retry: false,
  });
  const [removing, setRemoving] = React.useState<Removal | null>(null);
  const [renaming, setRenaming] = React.useState<Renaming | null>(null);
  const [changingPassword, setChangingPassword] =
    React.useState<PasswordTarget | null>(null);
  const [dismissing, setDismissing] = React.useState<string | null>(null);

  const sources = table.data?.sources;
  React.useEffect(() => {
    // 中继托管的页面：这张表是那台主机的，页面的源表是中继目录挂上的
    // （`sources/hosted.ts`），不拿主机的表去覆盖。
    if (sources && hostedRelay() === null) void applySourceTable(sources);
  }, [sources]);

  const remotes = internet.remotes;
  const others = (sources ?? []).filter((source) => source.kind !== "local");
  const mine = others.filter((source) => source.origin !== "shared");
  const shared = others.filter((source) => source.origin === "shared");
  const signedIn = remotes.filter((remote) => remote.hasCredentials);
  const pendingList = pending.data ?? [];
  const pendingOf = (issuer: string) => pendingCode(pendingList, issuer);
  // 账号行已经删了、中继侧还欠着的：放在高级里，登录回来再重试，或放弃清理。
  const orphans = pendingList.filter(
    (one) =>
      !(table.data?.remotes ?? []).some(
        (remote) => remote.issuer === one.issuer,
      ),
  );

  const logout = useMutation({
    mutationFn: (serviceId: string) => logoutRemote(serviceId),
    onSuccess: () => {
      void changed();
      toast.success(t("remote.signedOut"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const forget = useMutation({
    mutationFn: (sourceId: string) => forgetSource(sourceId),
    onSuccess: () => void changed(),
    onError: (error: Error) => toast.error(error.message),
  });
  const cleanup = useMutation({
    mutationFn: (issuer: string) => retryRelayCleanup(issuer),
    onSuccess: (code) => {
      void changed();
      if (code === null) toast.success(t("remote.relayPending.cleaned"));
      else toast.error(relayPendingReason(t, code) || t("remote.relayPending"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const dismiss = useMutation({
    mutationFn: (issuer: string) => dismissRelayCleanup(issuer),
    onSuccess: () => {
      void changed();
      toast.success(t("remote.relayPending.dismissed"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (target: Removal) => {
      if (target.kind === "source") {
        await removeSource(target.id);
        return null;
      }
      // 本机登记到它的，core 先撤销（连同中继侧的记录）再删行。
      await removeRemote(target.id);
      return target.issuer === undefined || target.issuer === ""
        ? null
        : pendingCode(await relayPending(), target.issuer);
    },
    onSuccess: (code, target) => {
      void changed();
      if (target.leave) toast.success(t("remote.left"));
      if (code !== null) {
        toast.warning(t("remote.relayPending"), {
          description: relayPendingReason(t, code),
        });
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const advancedRows = gateway.status?.enabled || orphans.length > 0;

  return (
    <>
      <section data-remote-block="host" className="flex min-w-0 flex-col gap-3">
        <h2 className={HEADING}>{t("remote.host")}</h2>
        <HostAccess />

        {remotes.length > 0 && (
          <SettingsGroup title={t("remote.services")}>
            {remotes.map((remote) => (
              <RemoteRow
                key={remote.serviceId}
                remote={remote}
                pending={pendingOf(remote.issuer)}
                tunnel={internet.tunnelOf(remote.issuer)}
                inUse={sameOrigin(remote.issuer, access.relayIssuer)}
                {...(canShare(remote)
                  ? {
                      onInternet: (on: boolean) => {
                        if (on) internet.start.mutate(remote);
                        else internet.stop.mutate([remote.issuer]);
                      },
                    }
                  : {})}
                onSignIn={() =>
                  setAdding({
                    issuer: remote.issuer,
                    account: remote.accountHint,
                    fingerprint: remote.fingerprint,
                  })
                }
                onSignOut={() => logout.mutate(remote.serviceId)}
                onRetryCleanup={() => cleanup.mutate(remote.issuer)}
                onChangePassword={() =>
                  setChangingPassword({
                    serviceId: remote.serviceId,
                    issuer: remote.issuer,
                  })
                }
                onRename={() =>
                  setRenaming({
                    kind: "remote",
                    id: remote.serviceId,
                    name: remote.label,
                    defaultName: remote.defaultLabel || remote.label,
                  })
                }
                onRemove={() =>
                  setRemoving({
                    kind: "remote",
                    id: remote.serviceId,
                    name: remote.label,
                    issuer: remote.issuer,
                  })
                }
              />
            ))}
          </SettingsGroup>
        )}

        {/* 经中继收发的流量（契约 §76）：有远程服务时才可能有。 */}
        {remotes.length > 0 && <HostTraffic />}

        <SettingsGroup title={t("remote.mine")}>
          {mine.map((source) => (
            <MineRow
              key={source.sourceId}
              source={source}
              inUse={source.sourceId === currentSourceId}
              {...(source.kind === "relayed"
                ? {
                    onTraffic: () =>
                      setTraffic({
                        sourceId: source.sourceId,
                        name: source.label,
                      }),
                  }
                : {})}
              onForget={() => forget.mutate(source.sourceId)}
              onRename={() => setRenaming(renamingOf(source))}
              onRemove={() =>
                setRemoving({
                  kind: "source",
                  id: source.sourceId,
                  name: source.label,
                })
              }
            />
          ))}
          <SettingsRow label={null}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAddingDirect(true)}
            >
              {t("remote.pairMine")}
            </Button>
            {signedIn.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setMounting(true)}
              >
                {t("remote.mount")}
              </Button>
            )}
          </SettingsRow>
        </SettingsGroup>

        <Collapsible className="group/advanced flex flex-col gap-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mx-2 w-fit text-[13px] font-normal text-muted-foreground"
            >
              <ChevronRight className="transition-transform group-data-[state=open]/advanced:rotate-90" />
              {t("remote.advanced")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SettingsGroup>
              {gateway.status && (
                <GatewayAdvanced
                  status={gateway.status}
                  saving={gateway.configure.isPending}
                  onConfigure={(patch) => gateway.configure.mutate(patch)}
                />
              )}
              {orphans.map((one) => (
                <SettingsRow
                  key={one.issuer}
                  label={hostOf(one.issuer)}
                  footnote={relayPendingReason(t, one.code)}
                >
                  <Badge variant="outline" className="font-normal">
                    {t("remote.relayPending")}
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={cleanup.isPending}
                    onClick={() => cleanup.mutate(one.issuer)}
                  >
                    {t("remote.relayPending.retry")}
                  </Button>
                  <RowMenu name={hostOf(one.issuer)}>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={dismiss.isPending}
                      onSelect={() => setDismissing(one.issuer)}
                    >
                      {t("remote.relayPending.dismiss")}
                    </DropdownMenuItem>
                  </RowMenu>
                </SettingsRow>
              ))}
              <SettingsRow label={advancedRows ? null : t("remote.services")}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setAdding({ issuer: "", account: "", fingerprint: "" })
                  }
                >
                  {t("remote.add")}
                </Button>
              </SettingsRow>
            </SettingsGroup>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section
        data-remote-block="joined"
        className="flex min-w-0 flex-col gap-3"
      >
        <h2 className={HEADING}>{t("remote.joined")}</h2>
        <SettingsGroup>
          {shared.map((source) => (
            <SharedRow
              key={source.sourceId}
              source={source}
              inUse={source.sourceId === currentSourceId}
              onTraffic={() =>
                setTraffic({
                  sourceId: source.sourceId,
                  name: source.ownerLabel.trim() || source.label,
                })
              }
              onLeave={() =>
                setRemoving({
                  kind: "source",
                  id: source.sourceId,
                  name: source.ownerLabel.trim() || source.label,
                  leave: true,
                })
              }
            />
          ))}
          <SettingsRow label={null}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setJoining("")}
            >
              {t("links.join")}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <SourceTrafficDialog target={traffic} onClose={() => setTraffic(null)} />
      <AddRelayDialog
        draft={adding}
        onClose={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          toast.success(t("remote.added"));
          void changed();
        }}
      />
      <AddDirectDialog
        open={addingDirect}
        onClose={() => setAddingDirect(false)}
        onDone={() => {
          setAddingDirect(false);
          toast.success(t("remote.added"));
          void changed();
        }}
      />
      <JoinLinkDialog
        initial={joining}
        onClose={() => setJoining(null)}
        onJoined={(sourceId) => {
          setJoining(null);
          toast.success(t("links.joined"));
          // 先记下要打开的源：收尾时壳可能为放行新来源重载页面。
          openAfterJoin(sourceId);
          void changed();
        }}
      />
      <MountDialog
        open={mounting}
        remotes={signedIn}
        onClose={() => setMounting(false)}
        onMounted={() => void changed()}
      />
      <ChangePasswordDialog
        target={changingPassword}
        onClose={() => setChangingPassword(null)}
      />
      <RenameDialog
        target={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (label) => {
          if (renaming === null) return;
          if (renaming.kind === "remote")
            await renameRemote(renaming.id, label);
          else await renameSource(renaming.id, label);
          toast.success(t("services.renamed"));
          void changed();
        }}
      />
      <ResponsiveAlertDialog
        open={dismissing !== null}
        onOpenChange={(open) => {
          if (!open) setDismissing(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("remote.relayPending.dismissConfirm", {
                name: dismissing === null ? "" : hostOf(dismissing),
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (dismissing !== null) dismiss.mutate(dismissing);
                setDismissing(null);
              }}
            >
              {t("remote.relayPending.dismiss")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
      <ResponsiveAlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t(
                removing?.leave
                  ? "remote.leaveConfirm"
                  : "remote.removeConfirm",
                {
                  name: removing?.name ?? "",
                },
              )}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove.mutate(removing);
                setRemoving(null);
              }}
            >
              {t(removing?.leave ? "remote.leave" : "remote.remove")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}

/** 正在改名的一行（契约 §61）：源表行或中转账号。 */
interface Renaming {
  readonly kind: "remote" | "source";
  readonly id: string;
  readonly name: string;
  readonly defaultName: string;
}

function renamingOf(source: ClientSource): Renaming {
  return {
    kind: "source",
    id: source.sourceId,
    name: source.label,
    // 旧版 core 不报缺省名：占位就是现在的名字。
    defaultName: source.defaultLabel || source.label,
  };
}

interface Removal {
  readonly kind: "remote" | "source";
  readonly id: string;
  readonly name: string;
  /** 中转账号的 issuer：删完看中继侧是否还欠着清理。 */
  readonly issuer?: string;
  /** 退出别人的分享（文案不同，行为同移除）。 */
  readonly leave?: boolean;
}
