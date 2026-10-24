import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight, Search, Users } from "lucide-react";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { rankOf } from "@/lib/cloud-grant";
import { Alert, AlertTitle } from "@/ui/alert";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { SkeletonTable } from "@/ui/skeletons";
import { Spinner } from "@/ui/spinner";
import { EmptyState, ErrorState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { useCloudApi } from "../api/context";
import { cloudKeys } from "../api/keys";
import { coveredByTeam, narrowedBy } from "../hosts/access-model";
import { useHostAccess, useHosts, type HostRow } from "../hosts/data";
import { GrantDialog, scopeText } from "../hosts/GrantDialog";
import {
  useEffective,
  useHostGrants,
  useRevokeGrant,
  type Grant,
} from "../hosts/grants-data";
import { tp } from "../i18n-plural";
import { RouteLink } from "../RouteLink";
import { PageHeader } from "../shell/PageHeader";
import type { TeamRole } from "../shell/model";
import { keyOfSpace } from "../space";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { Expiry } from "../ui/Expiry";
import { InlineError } from "../ui/InlineError";
import { useMembers, type TeamMember, type TeamSpace } from "./data";

const NEVER = "—";
const HOSTS_FETCHED = 200;
const TEAM = "team";
/** 同时在途的 `grants.list` 上限：主机多时不一口气发几百个请求。 */
const MAX_PARALLEL = 6;

/** 把异步任务限制在 `max` 个同时进行。 */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async <T,>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((go) => waiting.push(go));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

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

/** 撤销一条授予：先算会收窄谁并列名，个人的授予撤了而团队全员还兜着时写一句。 */
function RevokeEntryConfirm({
  space,
  open,
  entry,
  name,
  members,
  onClose,
}: {
  space: TeamSpace;
  open: boolean;
  entry: Entry;
  name: string;
  members: readonly TeamMember[];
  onClose: () => void;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const revoke = useRevokeGrant(space);
  const sourceId = entry.host.sourceId;
  const grants = useHostGrants(space, sourceId);
  const access = useHostAccess(space, sourceId);
  const list = new Intl.ListFormat(locale, {
    style: "narrow",
    type: "conjunction",
  });
  // 授予与访问表都到了才算得出收窄谁：所有者没到时会被误列进收窄名单。
  const ready = grants.data !== undefined && access.data !== undefined;
  const failure = grants.isError
    ? grants.error
    : access.isError
      ? access.error
      : null;
  const now = Date.now();
  const all = grants.data?.grants ?? [];
  const lowered = !ready
    ? []
    : narrowedBy({
        grants: all,
        members,
        ownerId:
          access.data?.access.find((row) => row.via === "owner")?.accountId ??
          null,
        change: { kind: "revoke", grantIds: [entry.grant.grantId] },
        now,
      });
  const subject = entry.grant.subject;
  const consequences = [
    ...(lowered.length > 0
      ? [
          t("cloud.grants.lowers", {
            names: list.format(lowered.map((member) => member.displayName)),
          }),
        ]
      : []),
    ...(subject.kind !== "team" &&
    subject.kind !== "group" &&
    coveredByTeam(
      subject.accountId,
      all.filter((grant) => grant.grantId !== entry.grant.grantId),
      members,
      now,
    )
      ? [t("cloud.grants.stillViaTeam")]
      : []),
  ];
  return (
    <ConfirmAction
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("cloud.grants.revokeTitle", { name, host: entry.host.name })}
      actionLabel={t("cloud.hosts.removeAccess")}
      pending={!ready}
      {...(failure
        ? {
            consequence: describeFailure(failure),
            onRetry: () => {
              if (grants.isError) void grants.refetch();
              if (access.isError) void access.refetch();
            },
          }
        : consequences.length > 0
          ? { consequence: consequences.join("\n") }
          : {})}
      onConfirm={async () => {
        try {
          await revoke.mutateAsync({ grantId: entry.grant.grantId, sourceId });
        } catch (failure) {
          toast.error(describeFailure(failure));
          throw failure;
        }
        toast.success(t("cloud.hosts.removeAccessDone"));
      }}
    />
  );
}

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
  const limit = React.useRef(createLimiter(MAX_PARALLEL));
  const lists = useQueries({
    queries: manageable.map((host) => ({
      queryKey: cloudKeys.grants(keyOfSpace(space), {
        sourceId: host.sourceId,
      }),
      queryFn: () =>
        limit.current(() =>
          api.client.grants.list({ sourceId: host.sourceId }),
        ),
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

  // 主机目录取不到整页失败；单台主机的授予取不到只标在那台上，可单台重试。
  const failed = hosts.error ?? members.error;
  const failedHosts = manageable.flatMap((host, index) => {
    const one = lists[index];
    return one?.isError ? [{ host, one }] : [];
  });
  // 整页骨架只等主机目录与成员；各台主机的授予在行内标「加载中」，不拖住整页。
  const loading = hosts.isPending || members.isPending;
  const hostsLoading = lists.some((one) => one.isPending);
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
          void members.refetch();
        }}
      />
    );
  else if (loading)
    body = <SkeletonTable rows={4} columns={4} label={t("cloud.nav.grants")} />;
  else if (rows.length === 0 && hostsLoading) body = null;
  else if (rows.length === 0 && failedHosts.length === 0)
    body = <EmptyState title={t("cloud.grants.empty")}>{add}</EmptyState>;
  else if (rows.length === 0) body = null;
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
      {hosts.hasNextPage ? (
        <Alert className="mb-4 flex flex-wrap items-center gap-2">
          <AlertTitle className="min-w-0 flex-1">
            {t("cloud.grants.incomplete", { count: manageable.length })}
          </AlertTitle>
          <Button
            size="sm"
            variant="outline"
            loading={hosts.isFetchingNextPage}
            onClick={() => void hosts.fetchNextPage()}
          >
            {t("cloud.common.loadMore")}
          </Button>
        </Alert>
      ) : null}
      {failedHosts.map(({ host, one }) => (
        <ErrorState
          key={host.sourceId}
          title={t("cloud.grants.hostFailed", {
            host: host.name,
            reason: describeFailure(one.error),
          })}
          retryLabel={t("cloud.common.retry")}
          onRetry={() => void one.refetch()}
          className="mb-4"
        />
      ))}
      {hostsLoading ? (
        <div className="mb-4 flex justify-center">
          <Spinner aria-label={t("cloud.nav.grants")} />
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
      {target?.kind === "revoke" ? (
        <RevokeEntryConfirm
          space={space}
          open={dialog?.kind === "revoke"}
          entry={target.entry}
          name={target.name}
          members={members.data?.members ?? []}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
