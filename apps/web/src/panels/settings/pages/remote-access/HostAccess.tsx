import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/ui/toast";
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
import { SettingsLoadable } from "../../SettingsLoadable";
import { sameOrigin, useRemoteAccess } from "../../remote-access";
import { GatewayPanel } from "../gateway/GatewayPanel";
import { PairingDialog } from "../gateway/PairingDialog";
import { AddCloudDialog } from "./CloudDialog";
import { InternetRow, type InternetState } from "./InternetRow";
import { useGateway, useInternetRoute, useRegisteredSpace } from "./hooks";
import { hostOf, useSourceTableChanged } from "./keys";

/** 关掉之前要确认的：整个关掉，或只停互联网路线。 */
type Confirming = "off" | "internet" | null;

/**
 * 远程访问页「这台电脑」（#301、#675）：「允许其他设备访问」开关、「互联网访问」、
 * 「手机扫码连接」三行。「互联网访问」以 Armadra 云为缺省：登记过就是开着（行上是
 * 空间与「更换」）；登录着、没登记的接着选空间登记；没登录的先走设备码登录再登记；
 * 只有个人中转账号的一键开。取消任何一步都停在仅局域网。
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
  // 打开着的 Armadra 云对话框：`null` 关着，空串是新登录；`resume` 是登录着的账号，
  // 直接落到选空间那一步；`current` 是更换空间时本机现在的空间。
  const [cloud, setCloud] = React.useState<{
    readonly issuer: string;
    readonly resume: boolean;
    readonly current?: string;
  } | null>(null);
  const [scanning, setScanning] = React.useState(false);
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
  // 点开「手机扫码连接」才铸一张（来源、信任锚变了重铸）；关掉就丢。票只活两分钟，
  // 过期后不自动续，等人点「新配对码」。
  const { mutate: mint } = pair;
  React.useEffect(() => {
    if (!running) setScanning(false);
  }, [running]);
  React.useEffect(() => {
    setPairing(null);
    if (scanning && running) mint(undefined);
  }, [scanning, running, origin, fingerprint, mint]);

  const shellManaged = status?.managedBy === "shell";
  const lanEditable = status !== null && !shellManaged;
  // 页面正经中转到达这台电脑：退回仅局域网就是自断。
  const internetInUse = internet.issuers.some((issuer) =>
    sameOrigin(issuer, access.relayIssuer),
  );

  // 本机登记在哪个 Armadra 云、哪个空间；没有云登记时是个人中转或只用令牌的登记。
  const cloudRemote = internet.remotes.find(
    (remote) => remote.kind === "saas" && remote.registered,
  );
  const space = useRegisteredSpace(cloudRemote);
  // 读不到空间时是空串：照样能更换，只是没有哪个空间被标成当前。
  const spaceValue =
    space === null
      ? ""
      : space.kind === "personal"
        ? "personal"
        : `team:${space.teamId}`;
  const routeLabel =
    internet.registered[0]?.label ??
    (internet.issuers[0] === undefined ? "" : hostOf(internet.issuers[0]));
  const route: InternetState = internet.on
    ? cloudRemote !== undefined
      ? {
          kind: "cloud",
          space,
          tunnel: internet.tunnelOf(cloudRemote.issuer),
        }
      : {
          kind: "relay",
          label: routeLabel,
          tunnel: internet.route,
        }
    : { kind: "off", via: internet.plan.kind === "start" ? "relay" : "cloud" };

  // 「互联网访问」没开时的入口，按 `planRoute` 走。
  function openInternet() {
    if (internet.on) return;
    const plan = internet.plan;
    if (plan.kind === "start") internet.start.mutate(plan.remote);
    else if (plan.kind === "ready") internet.refresh();
    else
      setCloud(
        plan.kind === "register"
          ? { issuer: plan.remote.issuer, resume: true }
          : { issuer: plan.issuer, resume: false },
      );
  }

  function changeSpace() {
    if (cloudRemote === undefined) return;
    setCloud({ issuer: cloudRemote.issuer, resume: true, current: spaceValue });
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
    else if (!status?.enabled) openInternet();
  }

  function confirm() {
    if (confirming === "off" && lanEditable && status.enabled)
      gateway.configure.mutate({ enabled: false });
    internet.stop.mutate(internet.issuers);
    setConfirming(null);
  }

  // 局域网那一半还没答：先画开关行的骨架，免得在不知道状态时点下去。
  return (
    <>
      <SettingsLoadable
        grouped
        loading={gateway.loading}
        rows={2}
        control="switch"
      >
        <GatewayPanel
          status={status}
          internet={internet.on}
          busy={gateway.configure.isPending || internet.busy}
          inUse={internetInUse}
          onToggle={toggle}
          onScan={() => setScanning(true)}
        >
          <InternetRow
            state={route}
            busy={internet.busy}
            locked={internetInUse}
            onSignIn={openInternet}
            onChange={changeSpace}
            onStop={() => setConfirming("internet")}
          />
        </GatewayPanel>
      </SettingsLoadable>
      <PairingDialog
        open={scanning && running}
        onClose={() => setScanning(false)}
        pairing={pairing}
        busy={pair.isPending}
        origins={status?.origins ?? []}
        fingerprint={fingerprint}
        caHref={
          status?.tls.caAvailable && status.origin
            ? `${status.origin}/ca.crt`
            : null
        }
        onNewPairing={(next) => pair.mutate(next)}
      />
      <AddCloudDialog
        initialIssuer={cloud?.issuer ?? null}
        autoStart={cloud?.resume ?? false}
        {...(cloud?.current === undefined ? {} : { current: cloud.current })}
        knownIssuers={internet.remotes.map((remote) => remote.issuer)}
        onClose={() => setCloud(null)}
        onChanged={() => void changed()}
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
