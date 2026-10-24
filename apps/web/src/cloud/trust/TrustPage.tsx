import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Field, FieldLabel } from "@/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { navigate } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { spaceBase, type CloudSpace } from "../space";
import { DataList, type DataColumn } from "../ui/DataList";
import { ConfirmAction } from "../ui/ConfirmAction";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import {
  endorseKey,
  useApproveTrust,
  useCanEndorse,
  useRefuseRequest,
  useRejectTrust,
  useTrustRequests,
} from "./data";
import { endorseCode, type TrustRequest } from "./endorser";

/** 校验码是 6 位数字。 */
const SAS_LENGTH = 6;

const memberName = (request: TrustRequest) =>
  request.member.displayName ||
  request.member.email ||
  request.member.accountId;

/** 输入新设备上的校验码：码只留在这个组件的状态里，交给端到端通道，不上传云端。 */
function TrustDialog({
  space,
  request,
  onClose,
}: {
  space: CloudSpace;
  request: TrustRequest;
  onClose: () => void;
}) {
  const t = useT();
  const approve = useApproveTrust(space);
  const client = useQueryClient();
  const refuse = useRefuseRequest(space);
  const [sas, setSas] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<"mismatch" | "expired" | null>(
    null,
  );
  // 这台浏览器不是受信设备：不再给「信任」，说明去哪处理。
  const [notTrusted, setNotTrusted] = React.useState(false);
  const id = React.useId();
  const submit = async () => {
    if (sas.length !== SAS_LENGTH || busy) return;
    setBusy(true);
    try {
      await approve(request, sas);
      toast.success(t("trust.trusted", { device: request.device.name }));
      onClose();
    } catch (failure) {
      const code = endorseCode(failure);
      if (code === "sas_mismatch") setProblem("mismatch");
      else if (code === "sas_expired") setProblem("expired");
      else if (code === "forbidden") {
        // 主机说这个人不能背书这条请求：只这一条记成不可背书；同一台主机上别的请求条件各不相同，不动。
        setNotTrusted(true);
        refuse(request.requestId);
      } else if (code === "device_untrusted") {
        // 主机说这台浏览器不是受信设备：这一条不可背书，这台主机的判定作废重判。
        setNotTrusted(true);
        refuse(request.requestId);
        void client.invalidateQueries({
          queryKey: endorseKey(space, request.sourceId),
        });
      } else if (code === "e2e_device_unavailable")
        toast.error(t("trust.unavailable"));
      else toast.error(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };
  const invalid = problem !== null;
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.trust.confirmTitle", {
              member: memberName(request),
              device: request.device.name,
            })}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {notTrusted ? (
            <span className="text-body text-destructive" role="status">
              {t("cloud.trust.useTrusted")}
            </span>
          ) : (
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={id}>{t("e2e.approve.hint")}</FieldLabel>
              <InputOTP
                id={id}
                maxLength={SAS_LENGTH}
                inputMode="numeric"
                pattern="^[0-9]*$"
                autoComplete="one-time-code"
                value={sas}
                onChange={(value) => {
                  setSas(value);
                  setProblem(null);
                }}
                aria-invalid={invalid}
              >
                <InputOTPGroup>
                  {Array.from({ length: SAS_LENGTH }, (_, index) => (
                    <InputOTPSlot
                      key={index}
                      index={index}
                      aria-invalid={invalid}
                    />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              {invalid ? (
                <span className="text-meta text-destructive" role="status">
                  {t(
                    problem === "mismatch"
                      ? "e2e.approve.mismatch"
                      : "e2e.approve.expired",
                  )}
                </span>
              ) : null}
            </Field>
          )}
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            {notTrusted ? null : (
              <Button
                type="submit"
                disabled={sas.length !== SAS_LENGTH}
                loading={busy}
              >
                {t("trust.trust")}
              </Button>
            )}
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 行尾：受信设备上给「拒绝 / 信任」；否则一枚徽标，不渲染按钮。 */
function TrustActions({
  space,
  request,
}: {
  space: CloudSpace;
  request: TrustRequest;
}) {
  const t = useT();
  const { pending, trusted } = useCanEndorse(space, request);
  const reject = useRejectTrust(space);
  const [dialog, setDialog] = React.useState<"trust" | "reject" | null>(null);
  if (pending) return null;
  // 对话框开着时（刚被主机拒绝）行尾已是徽标，对话框留着把原因说完，由人关掉。
  if (!trusted && dialog !== "trust")
    return <Badge variant="outline">{t("cloud.trust.useTrusted")}</Badge>;
  return (
    <>
      {trusted ? (
        <ButtonGroup>
          <Button
            variant="outline"
            size="sm"
            loading={reject.isPending}
            onClick={() => setDialog("reject")}
          >
            {t("e2e.approve.reject")}
          </Button>
          <Button size="sm" onClick={() => setDialog("trust")}>
            {t("trust.trust")}
          </Button>
        </ButtonGroup>
      ) : (
        <Badge variant="outline">{t("cloud.trust.useTrusted")}</Badge>
      )}
      {dialog === "trust" ? (
        <TrustDialog
          space={space}
          request={request}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmAction
        open={dialog === "reject"}
        onOpenChange={(next) => !next && setDialog(null)}
        title={t("cloud.trust.rejectTitle", {
          member: memberName(request),
          device: request.device.name,
        })}
        actionLabel={t("e2e.approve.reject")}
        onConfirm={async () => {
          try {
            await reject.mutateAsync(request.requestId);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
        }}
      />
    </>
  );
}

/**
 * 设备信任（云端控制台 §3.3.9）：待背书的新设备。列表只有成员、设备、平台、主机、时间，
 * 没有校验码；背书人输入新设备上显示的 6 位码，由端到端通道在主机侧核对。
 */
export function TrustPage({ space }: { space: CloudSpace }) {
  const t = useT();
  const list = useTrustRequests(space);
  const rows = React.useMemo(() => list.data?.requests ?? [], [list.data]);
  const columns = React.useMemo<DataColumn<TrustRequest>[]>(
    () => [
      {
        id: "member",
        header: t("cloud.hosts.who"),
        role: "primary",
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar size="sm">
              <AvatarFallback>{[...memberName(row)][0]}</AvatarFallback>
            </Avatar>
            <span className="truncate" translate="no">
              {memberName(row)}
            </span>
          </span>
        ),
      },
      {
        id: "device",
        header: t("trust.device"),
        cell: (row) => <span translate="no">{row.device.name}</span>,
      },
      {
        id: "platform",
        header: t("trust.platform"),
        cell: (row) => t(`cloud.account.platform.${row.device.platform}`),
      },
      {
        id: "host",
        header: t("trust.host"),
        cell: (row) => <span translate="no">{row.sourceName}</span>,
      },
      {
        id: "requested",
        header: t("cloud.trust.requested"),
        cell: (row) => <RelativeTime ms={row.requestedAtMs} />,
      },
    ],
    [t],
  );

  let body: React.ReactNode;
  if (list.isPending)
    body = <SkeletonTable rows={3} columns={5} label={t("cloud.nav.trust")} />;
  else if (list.isError)
    body = (
      <PageState
        code={toCloudError(list.error).code}
        onRetry={() => void list.refetch()}
        onHome={() => navigate(spaceBase(space))}
      />
    );
  else if (rows.length === 0)
    body = <EmptyState title={t("cloud.trust.empty")} />;
  else
    body = (
      <DataList
        caption={t("cloud.nav.trust")}
        rows={rows}
        columns={columns}
        rowKey={(row) => row.requestId}
        actionsHeader={t("cloud.common.actionsFor", {
          name: t("cloud.nav.trust"),
        })}
        actions={(row) => <TrustActions space={space} request={row} />}
      />
    );
  return (
    <>
      <PageHeader title={t("cloud.nav.trust")} />
      {body}
    </>
  );
}
