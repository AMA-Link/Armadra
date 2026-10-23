import * as React from "react";
import { ChevronRight, Download, Ellipsis, Users } from "lucide-react";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { rankOf } from "@/lib/cloud-grant";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { useMembers, type TeamSpace } from "../team/data";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { Expiry } from "../ui/Expiry";
import { InlineError } from "../ui/InlineError";
import {
  buildAccessRows,
  coveredByTeam,
  narrowedBy,
  type AccessRow,
} from "./access-model";
import { csvFileName, downloadCsv, toCsv } from "./csv";
import { useHostAccess, type HostDetail as HostDetailData } from "./data";
import { GrantDialog, scopeText } from "./GrantDialog";
import {
  useEffective,
  useHostGrants,
  useRevokeGrant,
  useRevokePersonAccess,
} from "./grants-data";

const NEVER = "—";

function useViaText() {
  const t = useT();
  return (via: string) => {
    switch (via) {
      case "owner":
        return t("cloud.hosts.viaOwner");
      case "direct":
      case "member":
      case "guest":
        return t("cloud.hosts.viaDirect");
      case "team":
        return t("cloud.hosts.viaTeam");
      case "link":
        return t("cloud.hosts.viaLink");
      default:
        return t("cloud.nav.groups");
    }
  };
}

const roleBadge = (t: ReturnType<typeof useT>, role: string) => (
  <Badge variant="outline">{t(`workspaceGroups.role.${role}`)}</Badge>
);

function Who({
  row,
  open,
  onToggle,
}: {
  row: AccessRow;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const face =
    row.kind === "team" ? (
      <Avatar size="sm">
        <AvatarFallback>
          <Users aria-hidden className="size-3.5" />
        </AvatarFallback>
      </Avatar>
    ) : (
      <Avatar size="sm">
        <AvatarFallback>{[...row.name][0]}</AvatarFallback>
      </Avatar>
    );
  const label = row.kind === "team" ? t("cloud.grants.everyone") : row.name;
  const text = (
    <span
      className="min-w-0 truncate"
      translate={row.kind === "team" ? "yes" : "no"}
    >
      {label}
    </span>
  );
  if (row.kind === "team")
    return (
      <span className="flex min-w-0 items-center gap-2">
        {face}
        {text}
      </span>
    );
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ms-2 max-w-full min-w-0 justify-start gap-2 font-normal"
      aria-expanded={open}
      aria-label={t("cloud.hosts.expandAccess", { name: row.name })}
      onClick={onToggle}
    >
      <ChevronRight
        aria-hidden
        className={
          open ? "rotate-90 transition-transform" : "transition-transform"
        }
      />
      {face}
      {text}
    </Button>
  );
}

/** 一个人的权限来源（`grants.effective` 的 `from`）：每条授予、团队全员、所有者各一行，各自可撤销。 */
function SourcesPanel({
  space,
  host,
  row,
  onRevoke,
}: {
  space: TeamSpace;
  host: HostDetailData;
  row: AccessRow;
  onRevoke: (target: { grantId: string; name: string }) => void;
}) {
  const t = useT();
  const via = useViaText();
  const effective = useEffective(
    space,
    host.sourceId,
    row.accountId ?? "",
    row.accountId !== null,
  );
  if (effective.isPending) return <SkeletonTable rows={2} columns={4} />;
  if (effective.isError)
    return (
      <InlineError
        error={effective.error}
        onRetry={() => void effective.refetch()}
      />
    );
  const composed = effective.data.role;
  return (
    <ul
      aria-label={t("cloud.hosts.sourcesOf", { name: row.name })}
      className="flex flex-col divide-y divide-border/60"
    >
      {effective.data.from.map((source, index) => {
        const lowered =
          composed !== null && rankOf(source.role) > rankOf(composed);
        const name =
          source.via === "team" ? t("cloud.grants.everyone") : row.name;
        return (
          <li
            key={source.grantId ?? `${source.via}-${index}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
          >
            <span className="w-28 shrink-0 text-body">{via(source.via)}</span>
            {roleBadge(t, source.role)}
            <span className="text-caption text-muted-foreground">
              {scopeText(t, source.workspaceIds)}
            </span>
            <span className="text-caption text-muted-foreground">
              {source.expiresAtMs === null ? (
                NEVER
              ) : (
                <Expiry ms={source.expiresAtMs} />
              )}
            </span>
            {lowered ? (
              <Badge variant="outline" className="text-warn-text">
                {t("cloud.hosts.lowered")}
              </Badge>
            ) : null}
            <span className="flex-1" />
            {source.grantId ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("cloud.hosts.removeAccessNamed", {
                  name: `${name} · ${via(source.via)}`,
                })}
                onClick={() => onRevoke({ grantId: source.grantId!, name })}
              >
                {t("cloud.hosts.removeAccess")}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type Dialog =
  | { kind: "grant"; subject?: string }
  | { kind: "revokePerson"; row: AccessRow }
  | { kind: "revokeGrant"; grantId: string; name: string }
  | null;

/**
 * 团队主机详情 · 访问（云端控制台 §3.3.5）：团队全员一行加每个有权限的人一行，展示合成后的最高权限；
 * 人名前的箭头展开每条来源（授予、团队全员、所有者）及各自的「撤销访问」。「添加访问」「改权限」是
 * `GrantDialog`；「导出」在浏览器里把当前清单拼成 CSV 下载，不调接口。
 */
export function TeamAccessTab({
  space,
  host,
  teamName,
}: {
  space: TeamSpace;
  host: HostDetailData;
  teamName: string;
}) {
  const t = useT();
  const via = useViaText();
  const locale = usePreferencesStore((state) => state.locale);
  const list = React.useMemo(
    () => new Intl.ListFormat(locale, { style: "narrow", type: "conjunction" }),
    [locale],
  );
  const access = useHostAccess(space, host.sourceId);
  const grants = useHostGrants(space, host.sourceId);
  const members = useMembers(space);
  const revokeGrant = useRevokeGrant(space);
  const revokePerson = useRevokePersonAccess(space);
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  // 关闭确认框的动画里 dialog 已是 null：标题用最后一个，免得闪空。
  const last = React.useRef(dialog);
  if (dialog !== null) last.current = dialog;

  const rows = React.useMemo(
    () =>
      access.data && grants.data
        ? buildAccessRows(
            access.data.access,
            grants.data.grants,
            members.data?.members ?? [],
            teamName,
            Date.now(),
          )
        : [],
    [access.data, grants.data, members.data, teamName],
  );

  const columns = React.useMemo<DataColumn<AccessRow>[]>(
    () => [
      {
        id: "who",
        header: t("cloud.hosts.who"),
        role: "primary",
        cell: (row) => (
          <Who
            row={row}
            open={expanded.has(row.id)}
            onToggle={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (!next.delete(row.id)) next.add(row.id);
                return next;
              })
            }
          />
        ),
      },
      {
        id: "access",
        header: t("cloud.hosts.access"),
        role: "trailing",
        cell: (row) => (
          <span className="flex items-center gap-1.5">
            {roleBadge(t, row.role)}
            {row.lowered ? (
              <Badge variant="outline" className="text-warn-text">
                {t("cloud.hosts.lowered")}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "scope",
        header: t("cloud.hosts.scope"),
        cell: (row) => scopeText(t, row.workspaceIds),
      },
      {
        id: "via",
        header: t("cloud.hosts.via"),
        cell: (row) => via(row.via),
      },
      {
        id: "expires",
        header: t("cloud.hosts.expires"),
        cell: (row) =>
          row.expiresAtMs === null ? NEVER : <Expiry ms={row.expiresAtMs} />,
      },
    ],
    [t, via, expanded],
  );

  if (access.isPending || grants.isPending)
    return (
      <SkeletonTable rows={4} columns={5} label={t("cloud.hosts.tabAccess")} />
    );
  if (access.isError || grants.isError)
    return (
      <InlineError
        error={access.error ?? grants.error}
        onRetry={() => {
          void access.refetch();
          void grants.refetch();
        }}
      />
    );

  const exportCsv = () => {
    downloadCsv(
      csvFileName(host.name, "access"),
      toCsv(
        [
          t("cloud.hosts.who"),
          t("cloud.hosts.email"),
          t("cloud.hosts.access"),
          t("cloud.hosts.scope"),
          t("cloud.hosts.via"),
          t("cloud.hosts.expires"),
        ],
        rows.map((row) => [
          row.kind === "team" ? t("cloud.grants.everyone") : row.name,
          row.email,
          t(`workspaceGroups.role.${row.role}`),
          scopeText(t, row.workspaceIds),
          via(row.via),
          row.expiresAtMs === null
            ? ""
            : new Date(row.expiresAtMs).toISOString(),
        ]),
      ),
    );
    toast.success(t("cloud.hosts.exported"));
  };

  const editable = (row: AccessRow) =>
    row.via !== "owner" && row.via !== "link";
  const target = last.current;
  // 撤销前先算会收窄谁：列名字（云端随后撤他们已签的令牌）；撤的是个人的授予而团队全员还兜着，说明一句。
  const revokeIds =
    target?.kind === "revokePerson"
      ? target.row.grants.map((grant) => grant.grantId)
      : target?.kind === "revokeGrant"
        ? [target.grantId]
        : [];
  const now = Date.now();
  const lowered = narrowedBy({
    grants: grants.data.grants,
    members: members.data?.members ?? [],
    ownerId:
      access.data.access.find((row) => row.via === "owner")?.accountId ?? null,
    change: { kind: "revoke", grantIds: revokeIds },
    now,
  });
  const consequences = [
    ...(lowered.length > 0
      ? [
          t("cloud.grants.lowers", {
            names: list.format(lowered.map((member) => member.displayName)),
          }),
        ]
      : []),
    ...(target?.kind === "revokePerson" &&
    target.row.accountId !== null &&
    coveredByTeam(
      target.row.accountId,
      grants.data.grants,
      members.data?.members ?? [],
      now,
    )
      ? [t("cloud.grants.stillViaTeam")]
      : []),
  ];
  const revokeName =
    target?.kind === "revokePerson"
      ? target.row.name
      : target?.kind === "revokeGrant"
        ? target.name
        : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length === 0}
          onClick={exportCsv}
        >
          <Download aria-hidden data-icon="inline-start" />
          {t("cloud.hosts.export")}
        </Button>
        <Button size="sm" onClick={() => setDialog({ kind: "grant" })}>
          {t("cloud.hosts.addAccess")}
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("cloud.hosts.noAccess")} />
      ) : (
        <DataList
          caption={t("cloud.hosts.tabAccess")}
          rows={rows}
          columns={columns}
          rowKey={(row) => row.id}
          expanded={expanded}
          detail={(row) =>
            row.kind === "person" ? (
              <SourcesPanel
                space={space}
                host={host}
                row={row}
                onRevoke={(grant) =>
                  setDialog({ kind: "revokeGrant", ...grant })
                }
              />
            ) : null
          }
          actionsHeader={t("cloud.hosts.removeAccess")}
          actions={(row) =>
            editable(row) ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    size="cluster"
                    label={t("cloud.common.actionsFor", {
                      name:
                        row.kind === "team"
                          ? t("cloud.grants.everyone")
                          : row.name,
                    })}
                    className="pointer-coarse:size-11"
                  >
                    <Ellipsis />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() =>
                      setDialog({
                        kind: "grant",
                        subject: row.accountId ?? "team",
                      })
                    }
                  >
                    {t("cloud.hosts.editAccess")}
                  </DropdownMenuItem>
                  {row.grants.length > 0 ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        setDialog(
                          row.kind === "team"
                            ? {
                                kind: "revokeGrant",
                                grantId: row.grants[0]!.grantId,
                                name: t("cloud.grants.everyone"),
                              }
                            : { kind: "revokePerson", row },
                        )
                      }
                    >
                      {t("cloud.hosts.removeAccess")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null
          }
        />
      )}
      {dialog?.kind === "grant" ? (
        <GrantDialog
          space={space}
          sourceId={host.sourceId}
          {...(dialog.subject === undefined ? {} : { subject: dialog.subject })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmAction
        open={dialog?.kind === "revokePerson" || dialog?.kind === "revokeGrant"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("cloud.grants.revokeTitle", {
          name: revokeName,
          host: host.name,
        })}
        actionLabel={t("cloud.hosts.removeAccess")}
        {...(consequences.length > 0
          ? { consequence: consequences.join("\n") }
          : {})}
        onConfirm={async () => {
          if (!dialog) return;
          try {
            if (dialog.kind === "revokePerson")
              await revokePerson.mutateAsync({
                sourceId: host.sourceId,
                accountId: dialog.row.accountId ?? "",
              });
            else if (dialog.kind === "revokeGrant")
              await revokeGrant.mutateAsync({
                grantId: dialog.grantId,
                sourceId: host.sourceId,
              });
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.hosts.removeAccessDone"));
        }}
      />
    </div>
  );
}
