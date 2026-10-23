import * as React from "react";
import { Ellipsis } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { tp } from "../i18n-plural";
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
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Field, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { useHosts } from "../hosts/data";
import { RouteLink } from "../RouteLink";
import { navigate } from "../router";
import { spaceBase, type CloudSpace } from "../space";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { InlineError } from "../ui/InlineError";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import {
  useLinks,
  useRevokeLink,
  useUpdateLinkNote,
  type LinkRow,
} from "./data";

const DAY = 86_400_000;
const SOON_DAYS = 7;

/** 用量 `{used} / {max}`；没有上限只写已用。 */
function useUsage() {
  const t = useT();
  return (row: LinkRow) =>
    row.maxUses === null
      ? String(row.uses)
      : t("cloud.links.usesValue", { used: row.uses, max: row.maxUses });
}

function Expiry({ row }: { row: LinkRow }) {
  const t = useT();
  const left = row.expiresAtMs - Date.now();
  if (left <= 0)
    return <Badge variant="outline">{t("cloud.common.expired")}</Badge>;
  if (left <= SOON_DAYS * DAY)
    return (
      <span className="text-warn-text">
        {tp("cloud.common.expiresIn", Math.max(1, Math.ceil(left / DAY)))}
      </span>
    );
  return <RelativeTime ms={row.expiresAtMs} />;
}

function EditNoteDialog({
  space,
  link,
  onClose,
}: {
  space: CloudSpace;
  link: LinkRow;
  onClose: () => void;
}) {
  const t = useT();
  const update = useUpdateLinkNote(space);
  const [label, setLabel] = React.useState(link.label);
  const id = React.useId();
  const submit = async () => {
    try {
      if (label.trim() !== link.label)
        await update.mutateAsync({ linkId: link.linkId, label: label.trim() });
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
            {t("cloud.links.editNote")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>{t("cloud.links.note")}</FieldLabel>
            <Input
              id={id}
              value={label}
              maxLength={128}
              autoComplete="off"
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button type="submit" loading={update.isPending}>
              {t("cloud.common.save")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function LinkMenu({ space, link }: { space: CloudSpace; link: LinkRow }) {
  const t = useT();
  const revoke = useRevokeLink(space);
  const [dialog, setDialog] = React.useState<"note" | "revoke" | null>(null);
  const name = link.label || t("cloud.links.untitled");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="cluster"
            label={t("cloud.common.actionsFor", { name })}
            className="pointer-coarse:size-11"
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog("note")}>
            {t("cloud.links.editNote")}
          </DropdownMenuItem>
          {link.revokedAtMs === null ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDialog("revoke")}
            >
              {t("cloud.links.revoke")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "note" ? (
        <EditNoteDialog
          space={space}
          link={link}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmAction
        open={dialog === "revoke"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("cloud.links.revokeTitle", { name })}
        actionLabel={t("cloud.links.revoke")}
        consequence={t("cloud.links.revokeConsequence")}
        onConfirm={async () => {
          try {
            await revoke.mutateAsync(link.linkId);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.links.revokeDone"));
        }}
      />
    </>
  );
}

/**
 * 链接列表（云端控制台 §3.3.8、§3.2.4），个人与团队、整个空间与单台主机共用。列：备注 · 目标 · 权限 ·
 * 用量 · 到期；行动作：编辑备注、撤销链接。链接地址只在新建时出现一次，列表不提供复制。
 * `sourceId` 给了就只列这台主机的（详情页的「链接」页签，不再画目标列）。
 */
export function LinksView({
  space,
  sourceId,
  variant = "page",
}: {
  space: CloudSpace;
  sourceId?: string;
  /** 页签里的取数失败画成区块内错误，不占整页。 */
  variant?: "page" | "tab";
}) {
  const t = useT();
  const links = useLinks(space, sourceId);
  const usage = useUsage();
  const hostNames = useHosts(space, {}, 200);
  const names = React.useMemo(
    () =>
      new Map(
        (hostNames.data?.pages ?? []).flatMap((page) =>
          page.sources.map((row) => [row.sourceId, row.name] as const),
        ),
      ),
    [hostNames.data],
  );

  const rows = React.useMemo(() => links.data?.links ?? [], [links.data]);
  const columns = React.useMemo<DataColumn<LinkRow>[]>(
    () => [
      {
        id: "note",
        header: t("cloud.links.note"),
        role: "primary",
        cell: (row) =>
          row.label ? (
            <span translate="no">{row.label}</span>
          ) : (
            <span className="text-muted-foreground">
              {t("cloud.links.untitled")}
            </span>
          ),
      },
      ...(sourceId === undefined
        ? [
            {
              id: "target",
              header: t("cloud.links.target"),
              cell: (row: LinkRow) =>
                row.sourceId === undefined ? null : (
                  <RouteLink
                    href={`${spaceBase(space)}/hosts/${encodeURIComponent(row.sourceId)}`}
                    className="rounded-control underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    translate="no"
                  >
                    {names.get(row.sourceId) ?? row.sourceId}
                  </RouteLink>
                ),
            },
          ]
        : []),
      {
        id: "role",
        header: t("cloud.hosts.access"),
        cell: (row) => {
          if (!row.role) return null;
          const key = `workspaceGroups.role.${row.role}`;
          const label = t(key);
          return (
            <Badge variant="outline">{label === key ? row.role : label}</Badge>
          );
        },
      },
      {
        id: "uses",
        header: t("cloud.links.uses"),
        numeric: true,
        cell: usage,
      },
      {
        id: "expires",
        header: t("cloud.hosts.expires"),
        cell: (row) => <Expiry row={row} />,
      },
      ...(rows.some((row) => row.revokedAtMs !== null)
        ? [
            {
              id: "status",
              header: t("cloud.hosts.status"),
              role: "trailing" as const,
              cell: (row: LinkRow) =>
                row.revokedAtMs === null ? null : (
                  <Badge variant="destructive">
                    {t("cloud.hosts.revoked")}
                  </Badge>
                ),
            },
          ]
        : []),
    ],
    [t, usage, names, sourceId, space, rows],
  );

  if (links.isPending)
    return <SkeletonTable rows={4} columns={5} label={t("cloud.nav.links")} />;
  if (links.isError)
    return variant === "tab" ? (
      <InlineError error={links.error} onRetry={() => void links.refetch()} />
    ) : (
      <PageState
        code={toCloudError(links.error).code}
        onRetry={() => void links.refetch()}
        onHome={() => navigate(spaceBase(space))}
      />
    );
  if (rows.length === 0) return <EmptyState title={t("cloud.links.empty")} />;
  return (
    <DataList
      caption={t("cloud.nav.links")}
      rows={rows}
      columns={columns}
      rowKey={(row) => row.linkId}
      actionsHeader={t("cloud.common.actionsFor", {
        name: t("cloud.nav.links"),
      })}
      actions={(row) => <LinkMenu space={space} link={row} />}
    />
  );
}
