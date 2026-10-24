import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { toCloudError } from "../api/errors";
import { useHosts } from "../hosts/data";
import { navigate, type RouteMatch } from "../router";
import { setQueryParam } from "../query-params";
import { PageHeader } from "../shell/PageHeader";
import { spaceBase } from "../space";
import { useMembers, type TeamSpace } from "../team/data";
import { PageState } from "../ui/PageState";
import { AuditList } from "./AuditList";
import { useAuditEvents } from "./data";
import { ACTION_TYPES, DEFAULT_RANGE, RANGES, filtersOf } from "./model";

const ALL = "all";
const HOSTS_FETCHED = 200;

/**
 * 审计（云端控制台 §3.3.10，M1）：时间范围 · 成员 · 主机 · 类型四个筛选（进地址），列表按
 * 游标「加载更多」，超过 50 行虚拟化，行内展开看对象 id、`jti`、IP 前缀。导出随 M2。
 */
export function AuditPage({
  match,
  space,
}: {
  match: RouteMatch;
  space: TeamSpace;
}) {
  const t = useT();
  const filters = filtersOf(match.query);
  const audit = useAuditEvents(space, filters);
  const members = useMembers(space);
  const hosts = useHosts(space, {}, HOSTS_FETCHED);

  const events = React.useMemo(
    () => audit.data?.pages.flatMap((page) => page.events) ?? [],
    [audit.data],
  );
  const memberList = React.useMemo(
    () => members.data?.members ?? [],
    [members.data],
  );
  const hostList = React.useMemo(
    () => hosts.data?.pages.flatMap((page) => page.sources) ?? [],
    [hosts.data],
  );
  const names = React.useMemo(
    () => ({
      members: new Map(
        memberList.map(
          (m) =>
            [m.accountId, m.displayName || m.email || m.accountId] as const,
        ),
      ),
      hosts: new Map(hostList.map((h) => [h.sourceId, h.name] as const)),
    }),
    [memberList, hostList],
  );

  const filtered =
    filters.range !== DEFAULT_RANGE ||
    filters.actor !== undefined ||
    filters.host !== undefined ||
    filters.type !== undefined;

  const select = (
    name: "range" | "actor" | "host" | "type",
    label: string,
    value: string,
    options: readonly { value: string; label: string }[],
    all?: string,
  ) => (
    <Select
      value={value}
      onValueChange={(next) =>
        setQueryParam(
          name,
          next === ALL || (name === "range" && next === DEFAULT_RANGE)
            ? null
            : next,
        )
      }
    >
      <SelectTrigger aria-label={label} className="w-44 max-sm:w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="z-[var(--z-dialog)]">
        {all ? <SelectItem value={ALL}>{all}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  let body: React.ReactNode;
  if (audit.isPending)
    body = <SkeletonTable rows={8} columns={5} label={t("cloud.nav.audit")} />;
  else if (audit.isError)
    body = (
      <PageState
        code={toCloudError(audit.error).code}
        onRetry={() => void audit.refetch()}
        onHome={() => navigate(spaceBase(space))}
      />
    );
  else if (events.length === 0)
    body = (
      <EmptyState title={t("cloud.audit.empty")}>
        {filtered ? (
          <Button
            variant="outline"
            onClick={() =>
              navigate(window.location.pathname, { replace: true })
            }
          >
            {t("cloud.common.clearFilters")}
          </Button>
        ) : null}
      </EmptyState>
    );
  else
    body = (
      <div className="flex flex-col gap-4">
        <AuditList
          events={events}
          names={names}
          caption={t("cloud.nav.audit")}
        />
        {audit.hasNextPage ? (
          <Button
            variant="outline"
            className="self-start"
            loading={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            {t("cloud.common.loadMore")}
          </Button>
        ) : null}
      </div>
    );

  return (
    <>
      <PageHeader title={t("cloud.nav.audit")} />
      <div
        role="search"
        className="mb-6 flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch"
      >
        {select(
          "range",
          t("cloud.audit.range"),
          filters.range,
          RANGES.map((range) => ({
            value: range,
            label: t(`cloud.audit.range${range}`),
          })),
        )}
        {select(
          "actor",
          t("cloud.audit.actor"),
          filters.actor ?? ALL,
          memberList.map((m) => ({
            value: m.accountId,
            label: m.displayName || m.email || m.accountId,
          })),
          t("cloud.audit.anyActor"),
        )}
        {select(
          "host",
          t("cloud.audit.host"),
          filters.host ?? ALL,
          hostList.map((h) => ({ value: h.sourceId, label: h.name })),
          t("cloud.audit.anyHost"),
        )}
        {select(
          "type",
          t("cloud.audit.type"),
          filters.type ?? ALL,
          ACTION_TYPES.map((type) => ({
            value: type,
            label: t(`cloud.audit.type.${type}`),
          })),
          t("cloud.audit.anyType"),
        )}
      </div>
      {body}
    </>
  );
}
