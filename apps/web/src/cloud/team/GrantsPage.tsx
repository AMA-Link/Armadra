import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight, Search, Users } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { rankOf } from "@/lib/cloud-grant";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { useCloudApi } from "../api/context";
import { cloudKeys } from "../api/keys";
import { useHosts, type HostRow } from "../hosts/data";
import { GrantDialog, scopeText } from "../hosts/GrantDialog";
import { useEffective, useRevokeGrant, type Grant } from "../hosts/grants-data";
import { tp } from "../i18n-plural";
import { RouteLink } from "../RouteLink";
import { PageHeader } from "../shell/PageHeader";
import type { TeamRole } from "../shell/model";
import { keyOfSpace } from "../space";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { Expiry } from "../ui/Expiry";
import { InlineError } from "../ui/InlineError";
import { useMembers, type TeamSpace } from "./data";

const NEVER = "—";
const HOSTS_FETCHED = 200;
const TEAM = "team";

interface Entry {
  readonly host: HostRow;
  readonly grant: Grant;
}

/** 授予页的一行：一个对象（团队全员或某个人）在各主机上的授予。 */
interface SubjectRow {
  readonly id: string;
  readonly kind: "team" | "person";
  readonly name: string;
  readonly entries: readonly Entry[];
}

const subjectId = (grant: Grant): string =>
  grant.subject.kind === "team"
    ? TEAM
    : grant.subject.kind === "group"
      ? grant.subject.groupId
      : grant.subject.accountId;

const roleBadge = (t: ReturnType<typeof useT>, role: string) => (
  <Badge variant="outline">{t(`workspaceGroups.role.${role}`)}</Badge>
);

function EffectiveBadge({
  space,
  entry,
  accountId,
}: {
  space: TeamSpace;
  entry: Entry;
  accountId: string;
}) {
  const t = useT();
  const effective = useEffective(space, entry.host.sourceId, accountId);
  if (!effective.data?.role) return null;
  const lowered = rankOf(effective.data.role) < rankOf(entry.grant.role);
  return (
    <span className="flex items-center gap-1.5">
      <span className="sr-only">{t("cloud.grants.effective")}</span>
      {roleBadge(t, effective.data.role)}
      {lowered ? (
        <Badge variant="outline" className="text-warn-text">
          {t("cloud.hosts.lowered")}
        </Badge>
      ) : null}
    </span>
  );
}

/** 展开的一行：这个对象在每台主机上的授予、有效权限（人）、授予人，行内改权限与撤销。 */
function HostEntries({
  space,
  row,
  names,
  onEdit,
  onRevoke,
}: {
  space: TeamSpace;
  row: SubjectRow;
  names: ReadonlyMap<string, string>;
  onEdit: (entry: Entry) => void;
  onRevoke: (entry: Entry) => void;
}) {
  const t = useT();
  return (
    <ul
      aria-label={row.kind === "team" ? t("cloud.grants.everyone") : row.name}
      className="flex flex-col divide-y divide-border/60"
    >
      {row.entries.map((entry) => (
        <li
          key={entry.grant.grantId}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
        >
          <RouteLink
            href={`/t/${encodeURIComponent(space.slug)}/hosts/${encodeURIComponent(entry.host.sourceId)}`}
            className="w-32 shrink-0 truncate rounded-control underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            translate="no"
          >
            {entry.host.name}
          </RouteLink>
          {roleBadge(t, entry.grant.role)}
          {row.kind === "person" ? (
            <EffectiveBadge space={space} entry={entry} accountId={row.id} />
          ) : null}
          <span className="text-caption text-muted-foreground">
            {scopeText(t, entry.grant.workspaceIds)}
          </span>
          <span className="text-caption text-muted-foreground">
            {entry.grant.expiresAtMs === null ? (
              NEVER
            ) : (
              <Expiry ms={entry.grant.expiresAtMs} />
            )}
          </span>
          <span className="text-caption text-muted-foreground" translate="no">
            <span className="sr-only">{t("cloud.grants.grantedBy")} </span>
            {names.get(entry.grant.grantedBy) ?? ""}
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${t("cloud.hosts.editAccess")} · ${entry.host.name}`}
            onClick={() => onEdit(entry)}
          >
            {t("cloud.hosts.editAccess")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("cloud.hosts.removeAccessNamed", {
              name: `${row.kind === "team" ? t("cloud.grants.everyone") : row.name} · ${entry.host.name}`,
            })}
            onClick={() => onRevoke(entry)}
          >
            {t("cloud.hosts.removeAccess")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; entry: Entry; subject: string }
  | { kind: "revoke"; entry: Entry; name: string }
  | null;

/**
 * 授予（云端控制台 §3.3.6）：按人看——团队全员与每个成员各一行（主机数 · 最高权限 · 最早到期），
 * 展开看逐台主机的授予与有效权限，行内改权限、撤销。云端没有按团队列全部授予的过程，所以这里对
 * 本人管得了的每台主机各取一次 `grants.list`（与主机详情共用缓存）；owner / admin 是全部主机，
 * member 是自己登记的，guest 与 billing 到不了这一页。
 */
export function GrantsPage({
  space,
  role,
}: {
  space: TeamSpace;
  role: TeamRole;
}) {
  const t = useT();
  const api = useCloudApi();
  const manager = role === "owner" || role === "admin";
  const hosts = useHosts(space, {}, HOSTS_FETCHED);
  const members = useMembers(space);
  const revoke = useRevokeGrant(space);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const last = React.useRef(dialog);
  if (dialog !== null) last.current = dialog;

  const manageable = React.useMemo(
    () =>
      (hosts.data?.pages.flatMap((page) => page.sources) ?? []).filter(
        (row) => manager || row.owner,
      ),
    [hosts.data, manager],
  );
  const lists = useQueries({
    queries: manageable.map((host) => ({
      queryKey: cloudKeys.grants(keyOfSpace(space), {
        sourceId: host.sourceId,
      }),
      queryFn: () => api.client.grants.list({ sourceId: host.sourceId }),
    })),
  });

  const names = React.useMemo(
    () =>
      new Map(
        (members.data?.members ?? []).map((member) => [
          member.accountId,
          member.displayName,
        ]),
      ),
    [members.data],
  );

  // 每次渲染重算（成员数量级的小列表）：`useQueries` 的结果每次都是新数组，没有稳定的依赖可记。
  const rows = ((): SubjectRow[] => {
    const byId = new Map<string, Entry[]>();
    manageable.forEach((host, index) => {
      for (const grant of lists[index]?.data?.grants ?? []) {
        if (grant.revokedAtMs !== null || grant.subject.kind === "group")
          continue;
        const key = subjectId(grant);
        byId.set(key, [...(byId.get(key) ?? []), { host, grant }]);
      }
    });
    return [...byId.entries()]
      .map(
        ([id, entries]): SubjectRow => ({
          id,
          kind: id === TEAM ? "team" : "person",
          name:
            id === TEAM ? t("cloud.grants.everyone") : (names.get(id) ?? id),
          entries,
        }),
      )
      .sort(
        (a, b) =>
          Number(b.kind === "team") - Number(a.kind === "team") ||
          a.name.localeCompare(b.name),
      );
  })();

  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) => row.name.toLowerCase().includes(needle));
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const columns = React.useMemo<DataColumn<SubjectRow>[]>(
    () => [
      {
        id: "subject",
        header: t("cloud.grants.subject"),
        role: "primary",
        cell: (row) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ms-2 max-w-full min-w-0 justify-start gap-2 font-normal"
            aria-expanded={expanded.has(row.id)}
            aria-label={`${row.name} · ${t("cloud.hosts.expandAccess", { name: row.name })}`}
            onClick={() => toggle(row.id)}
          >
            <ChevronRight
              aria-hidden
              className={
                expanded.has(row.id)
                  ? "rotate-90 transition-transform"
                  : "transition-transform"
              }
            />
            <Avatar size="sm">
              <AvatarFallback>
                {row.kind === "team" ? (
                  <Users aria-hidden className="size-3.5" />
                ) : (
                  [...row.name][0]
                )}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 truncate" translate="no">
              {row.name}
            </span>
          </Button>
        ),
      },
      {
        id: "hosts",
        header: t("cloud.grants.host"),
        role: "trailing",
        cell: (row) => tp("cloud.grants.hostsCount", row.entries.length),
      },
      {
        id: "highest",
        header: t("cloud.grants.highest"),
        cell: (row) =>
          roleBadge(
            t,
            row.entries.reduce(
              (best, entry) =>
                rankOf(entry.grant.role) > rankOf(best)
                  ? entry.grant.role
                  : best,
              row.entries[0]!.grant.role,
            ),
          ),
      },
      {
        id: "expiry",
        header: t("cloud.grants.nextExpiry"),
        cell: (row) => {
          const soonest = row.entries
            .map((entry) => entry.grant.expiresAtMs)
            .filter((ms): ms is number => ms !== null)
            .sort((a, b) => a - b)[0];
          return soonest === undefined ? NEVER : <Expiry ms={soonest} />;
        },
      },
    ],
    [t, expanded],
  );

  const failed = hosts.error ?? lists.find((one) => one.error)?.error;
  const loading =
    hosts.isPending || members.isPending || lists.some((one) => one.isPending);
  const add = (
    <Button size="sm" onClick={() => setDialog({ kind: "add" })}>
      {t("cloud.hosts.addAccess")}
    </Button>
  );

  let body: React.ReactNode;
  if (failed)
    body = (
      <InlineError
        error={failed}
        onRetry={() => {
          void hosts.refetch();
          lists.forEach((one) => void one.refetch());
        }}
      />
    );
  else if (loading)
    body = <SkeletonTable rows={4} columns={4} label={t("cloud.nav.grants")} />;
  else if (rows.length === 0)
    body = <EmptyState title={t("cloud.grants.empty")}>{add}</EmptyState>;
  else
    body = (
      <DataList
        caption={t("cloud.nav.grants")}
        rows={shown}
        columns={columns}
        rowKey={(row) => row.id}
        expanded={expanded}
        detail={(row) => (
          <HostEntries
            space={space}
            row={row}
            names={names}
            onEdit={(entry) =>
              setDialog({ kind: "edit", entry, subject: row.id })
            }
            onRevoke={(entry) =>
              setDialog({ kind: "revoke", entry, name: row.name })
            }
          />
        )}
      />
    );

  const target = last.current;
  return (
    <>
      <PageHeader
        title={t("cloud.nav.grants")}
        action={rows.length > 0 ? add : null}
      />
      {rows.length > 0 ? (
        <div role="search" className="mb-6">
          <InputGroup className="max-w-xs min-w-48">
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={t("cloud.grants.search")}
              placeholder={t("cloud.grants.search")}
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        </div>
      ) : null}
      {body}
      {rows.length > 0 && shown.length === 0 ? (
        <EmptyState title={t("cloud.common.noMatch", { query: query.trim() })}>
          <Button variant="outline" onClick={() => setQuery("")}>
            {t("cloud.common.clearFilters")}
          </Button>
        </EmptyState>
      ) : null}
      {dialog?.kind === "add" ? (
        <GrantDialog
          space={space}
          hosts={manageable}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "edit" ? (
        <GrantDialog
          space={space}
          sourceId={dialog.entry.host.sourceId}
          subject={dialog.subject}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmAction
        open={dialog?.kind === "revoke"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("cloud.grants.revokeTitle", {
          name: target?.kind === "revoke" ? target.name : "",
          host: target?.kind === "revoke" ? target.entry.host.name : "",
        })}
        actionLabel={t("cloud.hosts.removeAccess")}
        onConfirm={async () => {
          if (dialog?.kind !== "revoke") return;
          try {
            await revoke.mutateAsync({
              grantId: dialog.entry.grant.grantId,
              sourceId: dialog.entry.host.sourceId,
            });
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.hosts.removeAccessDone"));
        }}
      />
    </>
  );
}
