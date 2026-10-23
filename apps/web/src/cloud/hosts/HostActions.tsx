import * as React from "react";
import { Ellipsis } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { StatusPill } from "@/ui/status-pill";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import type { CloudSpace } from "../space";
import { TypedConfirm } from "../ui/TypedConfirm";
import { useRenameHost, useRevokeHost } from "./data";

/** 状态列（云端控制台 §4.2）：在线 `done`、离线 `idle`、已撤销 `Badge destructive`；文字与颜色同时给出。 */
export function HostStatus({
  online,
  revoked = false,
}: {
  online: boolean;
  revoked?: boolean;
}) {
  const t = useT();
  if (revoked)
    return <Badge variant="destructive">{t("cloud.hosts.revoked")}</Badge>;
  return online ? (
    <StatusPill tone="done" label={t("cloud.hosts.online")} />
  ) : (
    <StatusPill tone="idle" label={t("cloud.hosts.offline")} />
  );
}

/** 打开主机的画布：新标签 `/h/:host`。 */
export const hostCanvasHref = (sourceId: string) =>
  `/h/${encodeURIComponent(sourceId)}`;

/** 重命名：一个输入框，保存即生效；失败的提示归 sonner，对话框留着。 */
export function RenameHostDialog({
  space,
  host,
  onClose,
}: {
  space: CloudSpace;
  host: { sourceId: string; name: string };
  onClose: () => void;
}) {
  const t = useT();
  const rename = useRenameHost(space);
  const [name, setName] = React.useState(host.name);
  const [invalid, setInvalid] = React.useState(false);
  const id = React.useId();

  const submit = async () => {
    const next = name.trim();
    if (next === "") {
      setInvalid(true);
      return;
    }
    try {
      if (next !== host.name)
        await rename.mutateAsync({ sourceId: host.sourceId, name: next });
      toast.success(t("cloud.common.saved"));
      onClose();
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.hosts.renameTitle", { name: host.name })}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={id}>{t("cloud.hosts.name")}</FieldLabel>
            <Input
              id={id}
              value={name}
              maxLength={128}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              onChange={(event) => {
                setName(event.target.value);
                setInvalid(false);
              }}
            />
            {invalid ? (
              <FieldError>{t("cloud.hosts.nameRequired")}</FieldError>
            ) : null}
          </Field>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button type="submit" loading={rename.isPending}>
              {t("cloud.common.save")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 撤销主机：输入主机名确认（§4.3）；成功后 `onRevoked`（详情页回目录）。 */
export function RevokeHostConfirm({
  space,
  host,
  onClose,
  onRevoked,
}: {
  space: CloudSpace;
  host: { sourceId: string; name: string };
  onClose: () => void;
  onRevoked?: () => void;
}) {
  const t = useT();
  const revoke = useRevokeHost(space);
  return (
    <TypedConfirm
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("cloud.hosts.revokeTitle", { name: host.name })}
      expected={host.name}
      actionLabel={t("cloud.hosts.revoke")}
      onConfirm={async () => {
        try {
          await revoke.mutateAsync(host.sourceId);
        } catch (failure) {
          toast.error(describeFailure(failure));
          throw failure;
        }
        toast.success(t("cloud.hosts.revokeDone"));
        onRevoked?.();
      }}
    />
  );
}

/**
 * 主机行（与详情页头）的动作：表格里「打开」+ ⋯，窄屏列表里只有 ⋯（「打开」收进菜单）。
 * 重命名与撤销只给所有者（团队里还有管理员，服务端校验，答 `forbidden` 时 sonner 提示）。
 */
export function HostMenu({
  space,
  host,
  layout,
  onRevoked,
}: {
  space: CloudSpace;
  host: { sourceId: string; name: string; owner: boolean };
  layout: "table" | "list";
  onRevoked?: () => void;
}) {
  const t = useT();
  const [dialog, setDialog] = React.useState<"rename" | "revoke" | null>(null);
  const close = () => setDialog(null);
  return (
    <>
      {layout === "table" ? (
        <Button asChild size="sm" variant="ghost">
          <a
            href={hostCanvasHref(host.sourceId)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${t("cloud.common.open")} ${host.name}`}
          >
            {t("cloud.common.open")}
          </a>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="cluster"
            label={t("cloud.common.actionsFor", { name: host.name })}
            className="pointer-coarse:size-11"
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {layout === "list" ? (
            <DropdownMenuItem asChild>
              <a
                href={hostCanvasHref(host.sourceId)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("cloud.common.open")}
              </a>
            </DropdownMenuItem>
          ) : null}
          {host.owner ? (
            <>
              {layout === "list" ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => setDialog("rename")}>
                {t("cloud.hosts.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDialog("revoke")}
              >
                {t("cloud.hosts.revoke")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "rename" ? (
        <RenameHostDialog space={space} host={host} onClose={close} />
      ) : null}
      {dialog === "revoke" ? (
        <RevokeHostConfirm
          space={space}
          host={host}
          onClose={close}
          {...(onRevoked ? { onRevoked } : {})}
        />
      ) : null}
    </>
  );
}
