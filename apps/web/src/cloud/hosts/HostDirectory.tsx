import * as React from "react";
import { Search } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { RouteLink } from "../RouteLink";
import { navigate, type RouteMatch } from "../router";
import { spaceBase, type CloudSpace } from "../space";
import { DataList, type DataColumn } from "../ui/DataList";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import { toCloudError } from "../api/errors";
import { HostMenu, HostStatus } from "./HostActions";
import { useHosts, type HostFilters, type HostRow } from "./data";

const SEARCH_MAX = 128;
const SEARCH_DEBOUNCE_MS = 250;
const STATUSES = ["online", "offline", "revoked"] as const;
const ALL = "all";

/** 地址里的筛选（§1.4）：`?status=online&q=build`，可分享、可后退。 */
export function filtersOf(query: URLSearchParams): HostFilters {
  const status = query.get("status");
  const q = query.get("q")?.trim();
  return {
    ...(STATUSES.some((value) => value === status)
      ? { status: status as (typeof STATUSES)[number] }
      : {}),
    ...(q ? { q } : {}),
  };
}

/** 改一个查询参数（不留历史），其余参数不动；换筛选回到第一页。 */
function setParam(name: string, value: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (value === null || value === "") params.delete(name);
  else params.set(name, value);
  params.delete("cursor");
  const search = params.toString();
  navigate(window.location.pathname + (search ? `?${search}` : ""), {
    replace: true,
  });
}

/** 主机表：5 列（名称 · 状态 · 标签 · 最近在线 · 动作），窄屏同一份列定义画成 Item；概览也用它画前几行。 */
export function HostTable({
  space,
  rows,
  revoked = false,
}: {
  space: CloudSpace;
  rows: readonly HostRow[];
  /** 这批都是已撤销的（`status=revoked` 的筛选结果）。 */
  revoked?: boolean;
}) {
  const t = useT();
  const base = spaceBase(space);
  const columns = React.useMemo<DataColumn<HostRow>[]>(
    () => [
      {
        id: "name",
        header: t("cloud.hosts.name"),
        role: "primary",
        cell: (row) => (
          <RouteLink
            href={`${base}/hosts/${encodeURIComponent(row.sourceId)}`}
            className="rounded-control font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            translate="no"
          >
            {row.name}
          </RouteLink>
        ),
      },
      ...(space.kind === "team"
        ? [
            {
              id: "owner",
              header: t("cloud.hosts.owner"),
              role: "sub" as const,
              cell: (row: HostRow) =>
                row.ownerName ? (
                  <span translate="no">{row.ownerName}</span>
                ) : null,
            },
          ]
        : []),
      {
        id: "status",
        header: t("cloud.hosts.status"),
        role: "trailing",
        cell: (row) => <HostStatus online={row.online} revoked={revoked} />,
      },
      {
        id: "tags",
        header: t("cloud.hosts.tags"),
        cell: (row) =>
          row.tags && row.tags.length > 0 ? (
            <span className="flex flex-wrap gap-1" translate="no">
              {row.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </span>
          ) : null,
        listCell: (row) =>
          row.tags && row.tags.length > 0 ? (
            <span translate="no">{row.tags.join(" ")}</span>
          ) : null,
      },
      {
        id: "lastOnline",
        header: t("cloud.hosts.lastOnline"),
        cell: (row) =>
          row.lastSeenAtMs === null ? null : (
            <RelativeTime ms={row.lastSeenAtMs} />
          ),
      },
    ],
    [t, base, space.kind, revoked],
  );

  return (
    <DataList
      caption={t("cloud.nav.hosts")}
      rows={rows}
      columns={columns}
      rowKey={(row) => row.sourceId}
      actionsHeader={t("cloud.common.actionsFor", {
        name: t("cloud.nav.hosts"),
      })}
      actions={(row, layout) => (
        <HostMenu space={space} host={row} layout={layout} />
      )}
      onRowOpen={(row) =>
        navigate(`${base}/hosts/${encodeURIComponent(row.sourceId)}`)
      }
    />
  );
}

/**
 * 主机目录（云端控制台 §3.3.4、§3.2.2），个人与团队空间共用：5 列（名称 · 状态 · 标签 · 最近在线 ·
 * 动作），窄屏同一份列定义画成 Item；状态与搜索进地址，游标分页用「加载更多」。
 * 个人空间没有「所有者」第二行（都是自己的）。
 */
export function HostDirectory({
  space,
  match,
}: {
  space: CloudSpace;
  match: RouteMatch;
}) {
  const t = useT();
  const filters = filtersOf(match.query);
  const hosts = useHosts(space, filters);
  const rows = React.useMemo(
    () => hosts.data?.pages.flatMap((page) => page.sources) ?? [],
    [hosts.data],
  );
  const [draft, setDraft] = React.useState(filters.q ?? "");
  const base = spaceBase(space);

  React.useEffect(() => {
    if (draft.trim() === (filters.q ?? "")) return;
    const timer = setTimeout(
      () => setParam("q", draft.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [draft, filters.q]);

  const filtered = filters.status !== undefined || filters.q !== undefined;
  const clear = () => {
    setDraft("");
    navigate(window.location.pathname, { replace: true });
  };

  let body: React.ReactNode;
  if (hosts.isPending)
    body = <SkeletonTable rows={5} columns={5} label={t("cloud.nav.hosts")} />;
  else if (hosts.isError)
    body = (
      <PageState
        code={toCloudError(hosts.error).code}
        onRetry={() => void hosts.refetch()}
        onHome={() => navigate(base)}
      />
    );
  else if (rows.length === 0)
    body = filtered ? (
      <EmptyState title={t("cloud.common.noMatch", { query: filters.q ?? "" })}>
        <Button variant="outline" onClick={clear}>
          {t("cloud.common.clearFilters")}
        </Button>
      </EmptyState>
    ) : (
      <EmptyState title={t("cloud.hosts.empty")} />
    );
  else
    body = (
      <div className="flex flex-col gap-4">
        <HostTable
          space={space}
          rows={rows}
          revoked={filters.status === "revoked"}
        />
        {hosts.hasNextPage ? (
          <Button
            variant="outline"
            className="self-start"
            loading={hosts.isFetchingNextPage}
            onClick={() => void hosts.fetchNextPage()}
          >
            {t("cloud.common.loadMore")}
          </Button>
        ) : null}
      </div>
    );

  return (
    <>
      <div role="search" className="mb-6 flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-xs min-w-48 flex-1">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            enterKeyHint="search"
            aria-label={t("cloud.hosts.search")}
            placeholder={t("cloud.hosts.search")}
            autoComplete="off"
            spellCheck={false}
            maxLength={SEARCH_MAX}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </InputGroup>
        <Select
          value={filters.status ?? ALL}
          onValueChange={(value) =>
            setParam("status", value === ALL ? null : value)
          }
        >
          <SelectTrigger aria-label={t("cloud.hosts.status")} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            <SelectItem value={ALL}>{t("cloud.hosts.statusAll")}</SelectItem>
            {STATUSES.filter(
              (status) => status !== "revoked" || space.kind === "team",
            ).map((status) => (
              <SelectItem key={status} value={status}>
                {t(`cloud.hosts.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {body}
    </>
  );
}
