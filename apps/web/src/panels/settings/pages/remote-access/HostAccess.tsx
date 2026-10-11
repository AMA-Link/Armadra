import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { GatewayPairingPayload } from "@armadra/shared";

import { gatewayApi } from "../../../../api/gateway";
import { useT } from "../../../../app/preferences-store";
import { useAccess } from "../../../../app/use-access";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { RemoteShareSection } from "../../RemoteShare";
import { SettingsGroup } from "../../SettingsGroup";
import { sameOrigin, useRemoteAccess } from "../../remote-access";
import { GatewayPanel, type Reach } from "../gateway/GatewayPanel";
import { AddRelayDialog, type RelayDraft } from "./dialogs";
import { useGateway, useInternetRoute } from "./hooks";
import { useSourceTableChanged } from "./keys";

const BLANK: RelayDraft = { issuer: "", account: "", fingerprint: "" };

/** 关掉之前要确认的：整个关掉，或退回仅局域网。 */
type Confirming = "off" | "lan" | null;

/**
 * 远程访问页 A「这台电脑」的开关一块（#301）：允许其他设备访问这台电脑、可达
 * 范围、配对二维码与配对码；互联网路线开着时下面是分享链接。没有中转账号时选
 * 「局域网 + 互联网」先登录，登录好了再开路线。
 */
export function HostAccess() {
  const { member } = useAccess();
  return member ? null : <HostAccessBody />;
}

function HostAccessBody() {
  const t = useT();
  const changed = useSourceTableChanged();
  const gateway = useGateway();
  const internet = useInternetRoute();
  const access = useRemoteAccess();
  const status = gateway.status;
  const [signingIn, setSigningIn] = React.useState<RelayDraft | null>(null);
  const [wantInternet, setWantInternet] = React.useState(false);
  const [confirming, setConfirming] = React.useState<Confirming>(null);

  const [pairing, setPairing] = React.useState<GatewayPairingPayload | null>(
    null,
  );
  const pair = useMutation({
    mutationFn: (origin?: string) => gatewayApi.pair(origin),
    onSuccess: (payload) => setPairing(payload),
    onError: () => toast.error(t("gateway.pair.failed")),
  });
  const running = Boolean(status?.enabled && status.running);
  const origin = status?.origin ?? null;
  const fingerprint = status?.tls.fingerprint ?? null;
  // 开起来（或来源、信任锚变了）就铸一张；关掉就丢。票只活两分钟，过期后
  // 不自动续，等人点「新配对码」。
  const { mutate: mint } = pair;
  React.useEffect(() => {
    setPairing(null);
    if (running) mint(undefined);
  }, [running, origin, fingerprint, mint]);

  // 为开互联网路线先登录的：账号到了就开。
  const first = internet.shareable[0];
  const { mutate: startRoute } = internet.start;
  React.useEffect(() => {
    if (!wantInternet || first === undefined) return;
    setWantInternet(false);
    if (!internet.on) startRoute(first);
  }, [wantInternet, first, internet.on, startRoute]);

  const shellManaged = status?.managedBy === "shell";
  const lanEditable = status !== null && !shellManaged;
  // 页面正经中转到达这台电脑：退回仅局域网就是自断。
  const internetInUse = internet.issuers.some((issuer) =>
    sameOrigin(issuer, access.relayIssuer),
  );

  // 从下拉框里开出的对话框要等下拉框收起、焦点回到触发器之后再开，否则它一开
  // 就被当成「点到外面」关掉。
  function reach(next: Reach) {
    if (next === "lan") {
      if (internet.on) window.setTimeout(() => setConfirming("lan"), 0);
      return;
    }
    if (internet.on) return;
    if (first === undefined) {
      setWantInternet(true);
      window.setTimeout(() => setSigningIn(BLANK), 0);
    } else internet.start.mutate(first);
  }

  function toggle(on: boolean) {
    if (!on) {
      if (internet.on) setConfirming("off");
      else if (lanEditable) gateway.configure.mutate({ enabled: false });
      return;
    }
    if (lanEditable)
      gateway.configure.mutate(
        status.listen === "loopback"
          ? { enabled: true, listen: "private" }
          : { enabled: true },
      );
    else if (!status?.enabled) reach("internet");
  }

  function confirm() {
    if (confirming === "off" && lanEditable && status.enabled)
      gateway.configure.mutate({ enabled: false });
    internet.stop.mutate(internet.issuers);
    setConfirming(null);
  }

  // 局域网那一半还没答：先不画开关，免得在不知道状态时点下去。
  if (gateway.loading) return null;
  return (
    <>
      <GatewayPanel
        status={status}
        internet={internet.on}
        busy={gateway.configure.isPending || internet.busy}
        inUse={access.via !== null}
        internetInUse={internetInUse}
        onToggle={toggle}
        onReach={reach}
        pairing={pairing}
        pairingBusy={pair.isPending}
        onNewPairing={(next) => pair.mutate(next)}
      />
      {internet.registered.map((remote) => (
        <SettingsGroup
          key={remote.serviceId}
          {...(internet.registered.length > 1 ? { title: remote.label } : {})}
        >
          <RemoteShareSection remote={remote} />
        </SettingsGroup>
      ))}
      <AddRelayDialog
        draft={signingIn}
        onClose={() => {
          setSigningIn(null);
          setWantInternet(false);
        }}
        onDone={() => {
          setSigningIn(null);
          toast.success(t("remote.added"));
          void changed();
        }}
      />
      <ResponsiveAlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t(
                confirming === "off"
                  ? "remote.allow.offConfirm"
                  : "remote.internet.stopConfirm",
              )}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={confirm}
            >
              {t(
                confirming === "off"
                  ? "remote.allow.off"
                  : "remote.internet.stop",
              )}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
