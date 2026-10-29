import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { cloudTrustReject } from "../../api/remote-services";
import { RuntimeRequestError } from "../../api/request";
import { useT } from "../../app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import { toast } from "@/ui/toast";
import {
  HostPendingAmbiguous,
  HostPendingUnavailable,
  type TrustItem,
  approveOnHost,
  cloudTrustKey,
  matchOnHost,
  useCloudTrust,
} from "./cloud-trust";
import { useTrustDialog } from "./trust-store";
import {
  NativeOwnerHint,
  PlatformBadge,
} from "../../panels/settings/pages/security/platform-badge";

/**
 * 待信任的新设备（云端控制台 §3.5.3）：设备名、平台、成员与主机，加一个输入新设备上
 * 显示的 6 位校验码的框；「信任」把码交给主机在端到端通道里核对，「拒绝」只告诉云端
 * 这条请求作废。校验码不显示在横幅与对话框里，也不上传到云端。
 */
export function CloudTrustDialog() {
  const open = useTrustDialog((state) => state.open);
  const hide = useTrustDialog((state) => state.hide);
  const { items } = useCloudTrust();
  const current = items[0];
  React.useEffect(() => {
    if (open && current === undefined) hide();
  }, [open, current, hide]);
  if (!open || current === undefined) return null;
  return (
    <ResponsiveDialog open onOpenChange={(next) => !next && hide()}>
      <ResponsiveDialogContent
        data-testid="cloud-trust-dialog"
        className="z-(--z-dialog) sm:max-w-sm"
      >
        <TrustBody key={current.requestId} item={current} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function memberName(item: TrustItem): string {
  return item.member.displayName || item.member.email || item.member.accountId;
}

function TrustBody({ item }: { item: TrustItem }) {
  const t = useT();
  const client = useQueryClient();
  const [sas, setSas] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  // 这台电脑明确没有背书权限：不再给「信任」，只留「拒绝」，并说要在已信任的设备上处理。
  const [notEndorser, setNotEndorser] = React.useState(false);
  const refresh = () =>
    client.invalidateQueries({ queryKey: cloudTrustKey(item.serviceId) });
  // 平台与申请人以主机上对得上的那一行为准（契约 §88.7）：云端报的可以与主机登记的不同。
  const match = useQuery({
    queryKey: ["cloud-trust-match", item.serviceId, item.requestId],
    queryFn: () => matchOnHost(item),
    retry: false,
    staleTime: 0,
    // 给人看过的那一行不能悄悄换掉：窗口重新聚焦、重连都不重取，只有人点「重试」才重查。
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const host = match.data;
  // 对上的那一行换了（「重试」或全局失效后重查回来的是另一条申请）：已经输入的码是对着
  // 上一行输的，清掉重输，错误提示一起清。
  const [shownPendingId, setShownPendingId] = React.useState(host?.pendingId);
  if (host?.pendingId !== shownPendingId) {
    setShownPendingId(host?.pendingId);
    if (shownPendingId !== undefined) {
      setSas("");
      setInvalid(false);
    }
  }
  // 主机说这台电脑没有背书权限：与放行时被拒同样处理。
  const refused =
    match.error instanceof RuntimeRequestError &&
    (match.error.code === "forbidden" ||
      match.error.code === "device_untrusted");
  const blocked = notEndorser || refused;

  const trust = useMutation({
    // 只批给人看过的那一行：没查回来按钮就不可点（见下）。
    mutationFn: () => {
      if (host === undefined) throw new HostPendingUnavailable();
      return approveOnHost(item, sas, host);
    },
    onSuccess: () => {
      toast.success(t("trust.trusted", { device: item.device.name }));
      void refresh();
    },
    onError: (error: unknown) => {
      if (error instanceof RuntimeRequestError && error.code === "sas_mismatch")
        setInvalid(true);
      else if (error instanceof HostPendingAmbiguous)
        toast.error(t("trust.ambiguous"));
      else if (error instanceof HostPendingUnavailable)
        toast.error(t("trust.unavailable"));
      else if (
        error instanceof RuntimeRequestError &&
        (error.code === "forbidden" || error.code === "device_untrusted")
      )
        setNotEndorser(true);
      else
        toast.error(
          error instanceof Error ? error.message : t("error.internal"),
        );
    },
  });
  const reject = useMutation({
    mutationFn: () => cloudTrustReject(item.serviceId, item.requestId),
    onSuccess: () => void refresh(),
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : t("error.internal")),
  });
  const busy = trust.isPending || reject.isPending;

  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle className="truncate">
          {t("trust.title", { name: memberName(item) })}
        </ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      <form
        id="cloud-trust-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (sas.length === 6 && !busy && match.isSuccess) trust.mutate();
        }}
      >
        <FieldGroup className="gap-4">
          <dl
            data-slot="trust-facts"
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body"
          >
            <dt>{t("trust.device")}</dt>
            <dd className="min-w-0 truncate">{item.device.name}</dd>
            <dt>{t("trust.platform")}</dt>
            <dd className="min-w-0 truncate">
              {host === undefined ? (
                "—"
              ) : (
                <PlatformBadge platform={host.platform} />
              )}
            </dd>
            <dt>{t("trust.host")}</dt>
            <dd className="min-w-0 truncate">{item.sourceName}</dd>
          </dl>
          {host !== undefined && (
            <div className="flex flex-col gap-1">
              {host.platform !== item.device.platform && (
                <span className="text-meta text-destructive" role="status">
                  {t("trust.platformMismatch")}
                </span>
              )}
              <NativeOwnerHint
                platform={host.platform}
                principalKind={host.principalKind}
              />
            </div>
          )}
          {match.isError && !blocked && (
            <div className="flex items-center gap-2">
              <span className="text-meta text-destructive" role="status">
                {t(
                  match.error instanceof HostPendingAmbiguous
                    ? "trust.ambiguous"
                    : match.error instanceof HostPendingUnavailable
                      ? "trust.unavailable"
                      : "trust.hostUnreadable",
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={match.isFetching}
                onClick={() => void match.refetch()}
              >
                {t("state.retry")}
              </Button>
            </div>
          )}
          {blocked ? (
            <span className="text-body text-destructive" role="status">
              {t("cloud.trust.useTrusted")}
            </span>
          ) : (
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="cloud-trust-sas">
                {t("e2e.approve.hint")}
              </FieldLabel>
              <InputOTP
                id="cloud-trust-sas"
                maxLength={6}
                inputMode="numeric"
                pattern="^[0-9]*$"
                autoComplete="off"
                value={sas}
                onChange={(value) => {
                  setSas(value);
                  setInvalid(false);
                }}
                aria-invalid={invalid}
              >
                <InputOTPGroup>
                  {Array.from({ length: 6 }, (_, index) => (
                    <InputOTPSlot
                      key={index}
                      index={index}
                      aria-invalid={invalid}
                    />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              {invalid && (
                <span className="text-meta text-destructive" role="status">
                  {t("e2e.approve.mismatch")}
                </span>
              )}
            </Field>
          )}
        </FieldGroup>
      </form>
      <ResponsiveDialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          loading={reject.isPending}
          onClick={() => reject.mutate()}
        >
          {t("e2e.approve.reject")}
        </Button>
        {!blocked && (
          <Button
            type="submit"
            form="cloud-trust-form"
            disabled={sas.length !== 6 || busy || !match.isSuccess}
            loading={trust.isPending}
          >
            {t("trust.trust")}
          </Button>
        )}
      </ResponsiveDialogFooter>
    </>
  );
}
