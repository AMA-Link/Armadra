import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { E2ePairingPayload, TrustedDevice } from "@armadra/shared";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { DEVICES_QUERY_KEY, devicesApi } from "../../../../api/devices";
import { onWorkspaceEvent } from "../../../../api/events";
import { RuntimeRequestError } from "../../../../api/request";
import { localSource } from "../../../../api/source";
import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import { useAccess } from "../../../../app/use-access";
import { QrImage } from "../gateway/PairingCard";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { IconButton } from "@/ui/icon-button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

const STATUS_VARIANT = {
  pending: "default",
  trusted: "secondary",
  rejected: "outline",
  revoked: "outline",
} as const;

function failureText(t: ReturnType<typeof useT>, error: unknown): string {
  return error instanceof Error ? error.message : t("error.internal");
}

/** 设备列表随 `devices.pending` / `devices.changed` 重读（契约 §77）。 */
function useDeviceEvents(): void {
  const client = useQueryClient();
  React.useEffect(() => {
    const refresh = (_event: unknown, sourceId: string) => {
      if (sourceId === localSource.sourceId)
        void client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    };
    const offPending = onWorkspaceEvent("devices.pending", refresh, {
      allSources: true,
    });
    const offChanged = onWorkspaceEvent("devices.changed", refresh, {
      allSources: true,
    });
    return () => {
      offPending();
      offChanged();
    };
  }, [client]);
}

/**
 * 核对一台待确认设备：输入它屏幕上的 6 位校验码再「允许」，或「拒绝」。码不对不
 * 作废申请，可以再输。
 */
function ApproveForm({
  device,
  onDone,
}: {
  device: Pick<TrustedDevice, "pendingId" | "label">;
  onDone?: () => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const [sas, setSas] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const pendingId = device.pendingId ?? "";
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
      onDone?.();
    } catch (error) {
      if (error instanceof RuntimeRequestError && error.code === "sas_mismatch")
        setInvalid(true);
      else toast.error(failureText(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <InputOTP
        maxLength={6}
        inputMode="numeric"
        pattern="^[0-9]*$"
        value={sas}
        onChange={(value) => {
          setSas(value);
          setInvalid(false);
        }}
        aria-label={t("e2e.approve.hint")}
        aria-invalid={invalid}
      >
        <InputOTPGroup>
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot key={index} index={index} aria-invalid={invalid} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <Button
        type="button"
        size="sm"
        disabled={busy || sas.length !== 6}
        onClick={() => void run(() => devicesApi.approve(pendingId, sas))}
      >
        {t("e2e.approve.allow")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void run(() => devicesApi.reject(pendingId))}
      >
        {t("e2e.approve.reject")}
      </Button>
      {invalid && (
        <span className="text-[12px] text-destructive" role="status">
          {t("e2e.approve.mismatch")}
        </span>
      )}
    </div>
  );
}

/**
 * 设置 → 设备与会话 → 经中转的设备（契约 §77）：设备钥的列表，待确认的行内核对，
 * 其余可重命名、撤销、移除。没有任何一台时整块不出现。
 */
export function E2eDevices() {
  const t = useT();
  const client = useQueryClient();
  const locale = usePreferencesStore((state) => state.locale);
  // 设备钥只有 owner 管（契约 §77，与设置同一档）：成员不取，免得 403。
  const owner = !useAccess().member;
  useDeviceEvents();
  const devices = useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: devicesApi.list,
    retry: false,
    enabled: owner,
  });
  const [renaming, setRenaming] = React.useState<TrustedDevice | null>(null);
  const [label, setLabel] = React.useState("");
  const dateTime = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await client.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    } catch (error) {
      toast.error(failureText(t, error));
    }
  };
  // 没有权限（成员）或这台没装中继时整块不出现。
  if (!owner || devices.data === undefined) return null;
  const rows = devices.data;
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <h3 className="text-[13px] font-medium">{t("e2e.devices.title")}</h3>
        <PairDeviceButton />
      </div>
      {rows.length > 0 && (
        <Card className="gap-0 overflow-visible rounded-lg border border-border/70 px-2 py-0 text-[length:inherit] ring-0">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("e2e.devices.name")}</TableHead>
                <TableHead>{t("e2e.devices.account")}</TableHead>
                <TableHead>{t("e2e.devices.status")}</TableHead>
                <TableHead>{t("e2e.devices.lastSeen")}</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">{t("e2e.devices.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((device) => (
                <React.Fragment
                  key={`${device.deviceId}:${device.principalId}`}
                >
                  <TableRow>
                    <TableCell className="max-w-[16rem] truncate font-medium">
                      {device.label || device.deviceId.slice(0, 8)}
                      <span className="ml-2 text-muted-foreground">
                        {t(`e2e.platform.${device.platform}`)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate text-muted-foreground">
                      {device.principalName || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[device.status]}>
                        {t(`e2e.devices.status.${device.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {device.lastSeenAtMs > 0
                        ? dateTime.format(device.lastSeenAtMs)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton label={t("e2e.devices.actions")}>
                            <MoreHorizontal />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setLabel(device.label);
                              setRenaming(device);
                            }}
                          >
                            {t("e2e.devices.rename")}
                          </DropdownMenuItem>
                          {device.status === "trusted" && (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() =>
                                void act(() => devicesApi.revoke(device))
                              }
                            >
                              {t("e2e.devices.revoke")}
                            </DropdownMenuItem>
                          )}
                          {device.status !== "pending" && (
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() =>
                                void act(() => devicesApi.forget(device))
                              }
                            >
                              {t("e2e.devices.forget")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                  {device.status === "pending" && device.pendingId !== null && (
                    <TableRow>
                      <TableCell colSpan={5} className="pb-3">
                        <ApproveForm device={device} />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <ResponsiveDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("e2e.devices.rename")}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Input
            value={label}
            maxLength={128}
            aria-label={t("e2e.devices.renamePrompt")}
            onChange={(event) => setLabel(event.target.value)}
          />
          <ResponsiveDialogFooter>
            <Button
              type="button"
              disabled={label.trim() === ""}
              onClick={() => {
                const target = renaming;
                setRenaming(null);
                if (target !== null)
                  void act(() => devicesApi.rename(target, label.trim()));
              }}
            >
              {t("e2e.devices.save")}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </section>
  );
}

/** 指纹分组显示前 16 位（与服务器壳 CLI 一致）。 */
function shortFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * 「配对新设备」（契约 §80.1）：签一枚 5 分钟、一次性的配对秘密，二维码里是这台电脑
 * 的身份公钥与秘密；新设备扫了就钉住身份、不必再核对校验码。下面是指纹前 16 位，
 * 供人对照新设备上显示的那一串。
 */
function PairDeviceButton() {
  const t = useT();
  const [payload, setPayload] = React.useState<E2ePairingPayload | null>(null);
  const [busy, setBusy] = React.useState(false);
  const open = async () => {
    setBusy(true);
    try {
      setPayload(await devicesApi.pairingSecret());
    } catch (error) {
      toast.error(failureText(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void open()}
      >
        {t("e2e.pair.open")}
      </Button>
      <ResponsiveDialog
        open={payload !== null}
        onOpenChange={(next) => !next && setPayload(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{t("e2e.pair.title")}</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          {payload !== null && (
            <div className="flex flex-col items-center gap-3">
              <QrImage text={payload.uri} label={t("e2e.pair.title")} />
              <p className="font-mono text-[13px] text-muted-foreground tabular-nums">
                {shortFingerprint(payload.fingerprint)}
              </p>
            </div>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}

/**
 * 不在设置页时也要能放行（契约 §77）：本机收到 `devices.pending` 就弹一个核对框。
 * 关掉不拒绝——申请留在设置 → 设备与会话里。
 */
export function DeviceApprovalPrompt() {
  const t = useT();
  const [pending, setPending] = React.useState<{
    pendingId: string;
    label: string;
  } | null>(null);
  React.useEffect(
    () =>
      onWorkspaceEvent(
        "devices.pending",
        (event, sourceId) => {
          if (sourceId !== localSource.sourceId) return;
          setPending({ pendingId: event.pendingId, label: event.label });
        },
        { allSources: true },
      ),
    [],
  );
  if (pending === null) return null;
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && setPending(null)}>
      <ResponsiveDialogContent className="sm:max-w-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("e2e.approve.title", { name: pending.label || "—" })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t("e2e.approve.hint")}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ApproveForm
          device={{ pendingId: pending.pendingId, label: pending.label }}
          onDone={() => setPending(null)}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
